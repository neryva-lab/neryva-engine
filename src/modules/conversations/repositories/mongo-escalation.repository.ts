/**
 * MongoDB lane for `IEscalationRepository` (P3) — the persistence port for
 * `EscalationsService`.
 *
 * Behavioral truth: `src/modules/conversations/escalations.service.ts`.
 * Every method is one `withOrg` unit (multi-document transaction, majority
 * concern — plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` on every access (plan D6). UUIDs are BSON Binary
 * subtype 4 (plan D4), timestamps are ISO-8601 strings.
 *
 * The audit writes in the pg implementation fire from inside the transaction
 * on the success path only — this repository never audits; it reports
 * `created` / `transitioned` and the service replays the audit afterwards.
 */
import type { Db, Filter } from 'mongodb';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { nextSequence } from '../../../common/infra/db/mongo/concurrency/counters';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { buildEscalationBrief, type IEscalationRepository } from './escalation.repository';
import type { Escalation } from '../escalations.schema';
import {
  requireOrg,
  tenantCollection,
  toEscalation,
  type ConversationMongoDoc,
  type ConversationSummaryMongoDoc,
  type EscalationMongoDoc,
  type MessageMongoDoc,
  type RunEventMongoDoc,
  type RunMongoDoc,
} from './mongo-documents';

export class MongoEscalationRepository implements IEscalationRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /**
   * T6 — open an escalation: conversation read, idempotent open-row replay,
   * immutable brief-at-handoff composed in-TX, escalation insert,
   * conversation → 'escalated' (from 'active' only), outbox, optional
   * run.escalated event. One transaction (invariant 7).
   *
   * `created` is false on the idempotent replay path (existing WAITING/CLAIMED
   * row returned); the service audits only when true.
   */
  async escalate(input: {
    orgId: string;
    conversationId: string;
    runId?: string;
    /** Already trimmed to 128 chars and validated non-empty by the service. */
    reason: string;
    actor: string;
    slaSeconds?: number;
  }): Promise<{ escalation: Escalation; created: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const escalations = tenantCollection<EscalationMongoDoc>(db, 'escalations');
      const conversations = tenantCollection<ConversationMongoDoc>(db, 'conversations');

      const conversationIdBin = uuidToBinary(input.conversationId);
      const conv = await conversations.findOne(orgId, { id: conversationIdBin }, sessionOpt);
      if (!conv) {
        throw ApiError.notFound('conversation');
      }
      if (conv.status === 'archived' || conv.status === 'deleted') {
        throw ApiError.conflict('conversation is not escalatable', { status: conv.status });
      }

      // One open escalation per conversation — a repeated request replays the
      // existing WAITING/CLAIMED row (idempotent at the domain level). The
      // conversation read above serializes concurrent escalates the same way
      // the pg FOR UPDATE row lock does.
      const openFilter: Filter<EscalationMongoDoc> = {
        conversation_id: conversationIdBin,
        state: { $in: ['WAITING', 'CLAIMED'] },
      };
      const open = await escalations.findOne(orgId, openFilter, sessionOpt);
      if (open) {
        return { escalation: toEscalation(open), created: false };
      }

      const id = uuidv7();
      const now = new Date().toISOString();
      const slaExpiresAt =
        input.slaSeconds && input.slaSeconds > 0
          ? new Date(Date.now() + input.slaSeconds * 1000).toISOString()
          : null;
      // P0-3 — immutable brief-at-handoff, composed in the same TX.
      const brief = await this.composeBrief(db, ctx, orgId, input.conversationId, input.runId ?? null);
      await escalations.insertOne(
        orgId,
        {
          id: uuidToBinary(id),
          organization_id: uuidToBinary(orgId),
          conversation_id: conversationIdBin,
          run_id: input.runId ? uuidToBinary(input.runId) : null,
          reason: input.reason,
          state: 'WAITING',
          claimed_by: null,
          requested_at: now,
          claimed_at: null,
          resolved_at: null,
          sla_expires_at: slaExpiresAt,
          resolution_note: null,
          brief,
          created_at: now,
          updated_at: now,
        },
        sessionOpt,
      );

      // Pause the auto-responder (FL-1.7d) — only from 'active'; a re-escalate
      // on an already-escalated conversation keeps the status as-is.
      if (conv.status === 'active') {
        await conversations.updateOne(
          orgId,
          { id: conversationIdBin },
          { $set: { status: 'escalated', version: conv.version + 1, updated_at: now } },
          sessionOpt,
        );
      }

      const outbox = new MongoOutboxStore(db, ctx);
      await outbox.append({
        aggregateType: 'conversation',
        aggregateId: input.conversationId,
        organizationId: input.orgId,
        eventType: 'conversation.escalated',
        partitionKey: input.conversationId,
        payload: {
          conversation_id: input.conversationId,
          escalation_id: id,
          run_id: input.runId ?? null,
          reason: input.reason,
        },
      });

      if (input.runId) {
        const rowId = uuidv7();
        const engineSequence = await nextSequence(db, 'run_events:engine_sequence', {
          session: ctx.session,
        });
        await tenantCollection<RunEventMongoDoc>(db, 'run_events').insertOne(
          orgId,
          {
            id: uuidToBinary(rowId),
            organization_id: uuidToBinary(orgId),
            run_id: uuidToBinary(input.runId),
            event_id: rowId,
            event_type: 'run.escalated',
            schema_version: 1,
            engine_sequence: engineSequence,
            causation_id: null,
            correlation_id: null,
            producer_identity: 'engine:escalations',
            producer_sequence: null,
            payload: { escalation_id: id, reason: input.reason },
            artifact_id: null,
            created_at: now,
          },
          sessionOpt,
        );
      }

      const saved = await escalations.findOne(orgId, { id: uuidToBinary(id) }, sessionOpt);
      if (!saved) {
        throw ApiError.internal();
      }
      return { escalation: toEscalation(saved), created: true };
    });
  }

  /**
   * P0-3 — brief inputs, read in the escalation TX: newest compaction
   * summary, total message count, and the latest customer message excerpt.
   * Bounded and role-filtered here so the stored brief is safe to render.
   */
  private async composeBrief(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    conversationId: string,
    runId: string | null,
  ): Promise<Record<string, unknown>> {
    const sessionOpt = { session: ctx.session };
    const conversationIdBin = uuidToBinary(conversationId);
    const summaries = tenantCollection<ConversationSummaryMongoDoc>(db, 'conversation_summaries');
    const messages = tenantCollection<MessageMongoDoc>(db, 'messages');

    const latestSummary = await summaries
      .find(orgId, { conversation_id: conversationIdBin }, { ...sessionOpt, sort: { source_sequence: -1 }, limit: 1 })
      .toArray();
    const messageCount = await messages.countDocuments(
      orgId,
      { conversation_id: conversationIdBin },
      sessionOpt,
    );
    const lastUserDocs = await messages
      .find(
        orgId,
        { conversation_id: conversationIdBin, role: 'user' },
        { ...sessionOpt, sort: { sequence: -1 }, limit: 1 },
      )
      .toArray();
    const lastUserContent = lastUserDocs[0]?.content as { text?: unknown } | null | undefined;
    const lastUserText = typeof lastUserContent?.text === 'string' ? lastUserContent.text : null;

    let openRun: { id: string; state: string } | null = null;
    if (runId) {
      const runDoc = await tenantCollection<RunMongoDoc>(db, 'runs').findOne(
        orgId,
        { id: uuidToBinary(runId) },
        sessionOpt,
      );
      if (runDoc) {
        openRun = { id: runId, state: runDoc.state };
      }
    }
    return buildEscalationBrief({
      summary: latestSummary[0]?.summary ?? null,
      summarySequence: latestSummary[0]?.source_sequence ?? null,
      messageCount,
      lastUserText,
      openRun,
    });
  }

  /** Ordered queue (org + state, oldest first) for the agent console. */
  async listQueue(input: {
    orgId: string;
    state?: 'WAITING' | 'CLAIMED' | 'RESOLVED';
    limit?: number;
  }): Promise<Escalation[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const filter: Filter<EscalationMongoDoc> = input.state ? { state: input.state } : {};
      const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
      const docs = await tenantCollection<EscalationMongoDoc>(db, 'escalations')
        .find(orgId, filter, { session: ctx.session, sort: { requested_at: 1 }, limit })
        .toArray();
      return docs.map(toEscalation);
    });
  }

  /** Raw row read; the service maps missing → notFound. */
  async get(orgId: string, escalationId: string): Promise<Escalation | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const doc = await tenantCollection<EscalationMongoDoc>(db, 'escalations').findOne(
        requireOrg(ctx),
        { id: uuidToBinary(escalationId) },
        { session: ctx.session },
      );
      return doc ? toEscalation(doc) : null;
    });
  }

  /**
   * WAITING → CLAIMED with CAS semantics: same-agent re-claim replays,
   * other-agent re-claim conflicts, non-WAITING conflicts.
   * `transitioned` is false on the replay path; the service audits only when true.
   */
  async claim(input: {
    orgId: string;
    escalationId: string;
    agent: string;
    actor: string;
  }): Promise<{ escalation: Escalation; transitioned: boolean }> {
    return this.transitionToClaimed(input.orgId, input.escalationId, input.agent);
  }

  /** WAITING → CLAIMED with an admin-assigned agent identity (same CAS). */
  async assign(input: {
    orgId: string;
    escalationId: string;
    agent: string;
    actor: string;
  }): Promise<{ escalation: Escalation; transitioned: boolean }> {
    return this.transitionToClaimed(input.orgId, input.escalationId, input.agent);
  }

  private async transitionToClaimed(
    orgId: string,
    escalationId: string,
    agent: string,
  ): Promise<{ escalation: Escalation; transitioned: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const tenantId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const escalations = tenantCollection<EscalationMongoDoc>(db, 'escalations');

      const escalationIdBin = uuidToBinary(escalationId);
      const doc = await escalations.findOne(tenantId, { id: escalationIdBin }, sessionOpt);
      if (!doc) {
        throw ApiError.notFound('escalation');
      }
      if (doc.state === 'CLAIMED') {
        if (doc.claimed_by === agent) {
          return { escalation: toEscalation(doc), transitioned: false }; // replay
        }
        throw ApiError.conflict('escalation already claimed', { claimed_by: doc.claimed_by });
      }
      if (doc.state !== 'WAITING') {
        throw ApiError.conflict('escalation is not claimable', { state: doc.state });
      }
      const now = new Date().toISOString();
      const claimedBy = agent.trim().slice(0, 128);
      const updated = await escalations.findOneAndUpdate(
        tenantId,
        { id: escalationIdBin },
        {
          $set: {
            state: 'CLAIMED',
            claimed_by: claimedBy,
            claimed_at: now,
            updated_at: now,
          },
        },
        { ...sessionOpt, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.internal();
      }
      const conversationId = updated.conversation_id.toUUID().toString();
      const outbox = new MongoOutboxStore(db, ctx);
      await outbox.append({
        aggregateType: 'conversation',
        aggregateId: conversationId,
        organizationId: orgId,
        eventType: 'conversation.escalation.claimed',
        partitionKey: conversationId,
        payload: {
          conversation_id: conversationId,
          escalation_id: updated.id.toUUID().toString(),
          claimed_by: claimedBy,
        },
      });
      return { escalation: toEscalation(updated), transitioned: true };
    });
  }

  /**
   * CLAIMED → RESOLVED: close the escalation and resume the auto-responder
   * (conversation → 'active') only when no other escalation is still open.
   * `transitioned` is false on the replay path; the service audits only when true.
   */
  async resolve(input: {
    orgId: string;
    escalationId: string;
    note?: string;
    actor: string;
  }): Promise<{ escalation: Escalation; transitioned: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const escalations = tenantCollection<EscalationMongoDoc>(db, 'escalations');
      const conversations = tenantCollection<ConversationMongoDoc>(db, 'conversations');

      const escalationIdBin = uuidToBinary(input.escalationId);
      const doc = await escalations.findOne(orgId, { id: escalationIdBin }, sessionOpt);
      if (!doc) {
        throw ApiError.notFound('escalation');
      }
      if (doc.state === 'RESOLVED') {
        return { escalation: toEscalation(doc), transitioned: false }; // replay
      }
      if (doc.state !== 'CLAIMED') {
        throw ApiError.conflict('escalation must be claimed before resolution', { state: doc.state });
      }
      const now = new Date().toISOString();
      const updated = await escalations.findOneAndUpdate(
        orgId,
        { id: escalationIdBin },
        {
          $set: {
            state: 'RESOLVED',
            resolved_at: now,
            resolution_note: input.note?.slice(0, 2048) ?? null,
            updated_at: now,
          },
        },
        { ...sessionOpt, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.internal();
      }

      // Resume the auto-responder (FL-1.7d) — only if no other escalation
      // opened in the meantime.
      const conversationIdBin = updated.conversation_id;
      const stillOpen = await escalations.findOne(
        orgId,
        { conversation_id: conversationIdBin, state: { $in: ['WAITING', 'CLAIMED'] } },
        sessionOpt,
      );
      if (!stillOpen) {
        const conv = await conversations.findOne(orgId, { id: conversationIdBin }, sessionOpt);
        if (conv && conv.status === 'escalated') {
          await conversations.updateOne(
            orgId,
            { id: conversationIdBin },
            { $set: { status: 'active', version: conv.version + 1, updated_at: now } },
            sessionOpt,
          );
        }
      }

      const conversationId = conversationIdBin.toUUID().toString();
      const outbox = new MongoOutboxStore(db, ctx);
      await outbox.append({
        aggregateType: 'conversation',
        aggregateId: conversationId,
        organizationId: input.orgId,
        eventType: 'conversation.escalation.resolved',
        partitionKey: conversationId,
        payload: {
          conversation_id: conversationId,
          escalation_id: updated.id.toUUID().toString(),
        },
      });
      return { escalation: toEscalation(updated), transitioned: true };
    });
  }

  /**
   * Human-agent reply: lock the open escalation, lock the conversation,
   * allocate the sequence, insert the service-authored message, outbox.
   * No run is created and the auto-responder is not triggered.
   */
  async agentReply(input: {
    orgId: string;
    conversationId: string;
    escalationId: string;
    agent: string;
    /** Already trimmed to 8192 chars and validated non-empty by the service. */
    text: string;
  }): Promise<{ message_id: string; sequence: number }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const escalations = tenantCollection<EscalationMongoDoc>(db, 'escalations');
      const conversations = tenantCollection<ConversationMongoDoc>(db, 'conversations');
      const messages = tenantCollection<MessageMongoDoc>(db, 'messages');

      const conversationIdBin = uuidToBinary(input.conversationId);
      const escalation = await escalations.findOne(
        orgId,
        { id: uuidToBinary(input.escalationId), conversation_id: conversationIdBin },
        sessionOpt,
      );
      if (!escalation) {
        throw ApiError.notFound('escalation');
      }
      if (escalation.state === 'RESOLVED') {
        throw ApiError.conflict('escalation is resolved; replies belong to the assistant', {
          state: escalation.state,
        });
      }
      const conv = await conversations.findOne(orgId, { id: conversationIdBin }, sessionOpt);
      if (!conv) {
        throw ApiError.notFound('conversation');
      }
      // Counter allocation replaces the pg max()+1-under-FOR-UPDATE lock and
      // is strictly stronger: concurrent callers never observe the same value.
      const sequence = await nextSequence(db, `conversation:${input.conversationId}:message_seq`, {
        session: ctx.session,
      });
      const messageId = uuidv7();
      const now = new Date().toISOString();
      await messages.insertOne(
        orgId,
        {
          id: uuidToBinary(messageId),
          organization_id: uuidToBinary(orgId),
          conversation_id: conversationIdBin,
          sequence,
          role: 'assistant',
          content: { text: input.text, author: 'human_agent', escalation_id: input.escalationId },
          created_by: input.agent.slice(0, 128),
          created_at: now,
        },
        sessionOpt,
      );
      // Channel relay (FL-1.7b) — the outbound consumer forwards
      // service-authored messages to the bound platform (window policy kept).
      const outbox = new MongoOutboxStore(db, ctx);
      await outbox.append({
        aggregateType: 'message',
        aggregateId: messageId,
        organizationId: input.orgId,
        eventType: 'message.created',
        partitionKey: input.conversationId,
        payload: {
          message_id: messageId,
          conversation_id: input.conversationId,
          author: 'human_agent',
        },
      });
      return { message_id: messageId, sequence };
    });
  }
}
