import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { conversations, conversationSummaries, messages, runEvents, runs } from './schema';
import { escalations, type Escalation } from './escalations.schema';
import { nextMessageSequence } from './conversations.service';

/**
 * Human handoff / live-agent takeover (FL-1.7). Every mutation is one
 * transaction: the escalation row AND the conversation status flip AND the
 * outbox event commit or roll back together (invariant 7). The queue list is
 * the ordered wait surface for agent consoles.
 *
 * State machine (FL-1.7a): WAITING → CLAIMED → RESOLVED. Claim/assign are the
 * same CAS transition with different actor semantics (self-claim vs admin
 * assignment). Resolve flips the conversation back to 'active' (FL-1.7d).
 */
@Injectable()
export class EscalationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Open an escalation and pause the auto-responder. Run-originated requests
   * (the `request_human_handoff` tool) pass the run id — a run_events row is
   * written on that run so its SSE stream shows the takeover.
   */
  async escalate(input: {
    orgId: string;
    conversationId: string;
    runId?: string;
    reason: string;
    actor: string;
    slaSeconds?: number;
  }): Promise<Escalation> {
    const reason = input.reason.trim().slice(0, 128);
    if (!reason) {
      throw ApiError.validation({ reason: 'must not be empty' });
    }
    return this.db.withOrg(input.orgId, async (tx) => {
      const conv = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update')
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      const conversation = conv[0];
      if (conversation.status === 'archived' || conversation.status === 'deleted') {
        throw ApiError.conflict('conversation is not escalatable', { status: conversation.status });
      }
      // One open escalation per conversation — a repeated request replays the
      // existing WAITING row (idempotent at the domain level).
      const open = await tx
        .select()
        .from(escalations)
        .where(
          and(
            eq(escalations.organizationId, input.orgId),
            eq(escalations.conversationId, input.conversationId),
            inArray(escalations.state, ['WAITING', 'CLAIMED']),
          ),
        )
        .limit(1);
      if (open.length > 0) {
        return open[0];
      }

      const id = uuidv7();
      const slaExpiresAt =
        input.slaSeconds && input.slaSeconds > 0
          ? new Date(Date.now() + input.slaSeconds * 1000).toISOString()
          : null;
      // P0-3 — immutable brief-at-handoff, composed in the same TX: the
      // human arrives briefed even as the conversation moves on afterwards.
      const brief = await this.composeBrief(tx, input.orgId, input.conversationId, input.runId ?? null);
      const inserted = await tx
        .insert(escalations)
        .values({
          id,
          organizationId: input.orgId,
          conversationId: input.conversationId,
          runId: input.runId ?? null,
          reason,
          state: 'WAITING',
          brief,
          ...(slaExpiresAt !== null ? { slaExpiresAt } : {}),
        })
        .returning();

      // Pause the auto-responder (FL-1.7d) — only from 'active'; a re-escalate
      // on an already-escalated conversation keeps the status as-is.
      if (conversation.status === 'active') {
        await tx
          .update(conversations)
          .set({ status: 'escalated', version: conversation.version + 1, updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, conversation.id));
      }

      await recordOutboxEvent(tx, {
        aggregateType: 'conversation',
        aggregateId: input.conversationId,
        organizationId: input.orgId,
        eventType: 'conversation.escalated',
        partitionKey: input.conversationId,
        payload: {
          conversation_id: input.conversationId,
          escalation_id: id,
          run_id: input.runId ?? null,
          reason,
        },
      });

      if (input.runId) {
        const rowId = uuidv7();
        await tx.insert(runEvents).values({
          id: rowId,
          eventId: rowId,
          runId: input.runId,
          organizationId: input.orgId,
          eventType: 'run.escalated',
          payload: { escalation_id: id, reason },
          producerIdentity: 'engine:escalations',
        });
      }

      await this.audit.add({
        action: 'escalation.opened',
        resourceType: 'escalation',
        resourceId: id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { conversation_id: input.conversationId, run_id: input.runId ?? null, reason },
      });
      return inserted[0];
    });
  }

  /**
   * P0-3 — brief inputs, read in the escalation TX: newest compaction
   * summary, total message count, and the latest customer message excerpt.
   * Bounded and role-filtered here so the stored brief is safe to render.
   */
  private async composeBrief(
    tx: Parameters<Parameters<DbService['withOrg']>[1]>[0],
    orgId: string,
    conversationId: string,
    runId: string | null,
  ): Promise<Record<string, unknown>> {
    const summaries = await tx
      .select({ summary: conversationSummaries.summary, sourceSequence: conversationSummaries.sourceSequence })
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.organizationId, orgId), eq(conversationSummaries.conversationId, conversationId)))
      .orderBy(desc(conversationSummaries.sourceSequence))
      .limit(1);
    const counts = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.organizationId, orgId), eq(messages.conversationId, conversationId)));
    const lastUser = await tx
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.organizationId, orgId), eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
      .orderBy(desc(messages.sequence))
      .limit(1);
    let openRun: { id: string; state: string } | null = null;
    if (runId) {
      const runRows = await tx
        .select({ id: runs.id, state: runs.state })
        .from(runs)
        .where(and(eq(runs.organizationId, orgId), eq(runs.id, runId)))
        .limit(1);
      if (runRows[0]) {
        openRun = { id: runRows[0].id, state: runRows[0].state };
      }
    }
    return buildEscalationBrief({
      summary: summaries[0]?.summary ?? null,
      summarySequence: summaries[0]?.sourceSequence ?? null,
      messageCount: Number(counts[0]?.n ?? 0),
      lastUserText: typeof (lastUser[0]?.content as { text?: unknown } | null)?.text === 'string' ? ((lastUser[0]?.content as { text: string }).text as string) : null,
      openRun,
    });
  }

  /** Ordered queue (org + state, oldest first) — the agent console surface. */  async listQueue(input: {
    orgId: string;
    state?: 'WAITING' | 'CLAIMED' | 'RESOLVED';
    limit?: number;
  }): Promise<Escalation[]> {
    const conditions = [eq(escalations.organizationId, input.orgId)];
    if (input.state) {
      conditions.push(eq(escalations.state, input.state));
    }
    return this.db.withOrg(input.orgId, (tx) =>
      tx
        .select()
        .from(escalations)
        .where(and(...conditions))
        .orderBy(asc(escalations.requestedAt))
        .limit(Math.min(Math.max(1, input.limit ?? 50), 200)),
    );
  }

  async get(orgId: string, escalationId: string): Promise<Escalation> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(escalations)
        .where(and(eq(escalations.organizationId, orgId), eq(escalations.id, escalationId)))
        .limit(1),
    );
    if (rows.length === 0) {
      throw ApiError.notFound('escalation');
    }
    return rows[0];
  }

  /** WAITING → CLAIMED (self-claim). */
  async claim(input: { orgId: string; escalationId: string; agent: string; actor: string }): Promise<Escalation> {
    return this.transitionToClaimed(input.orgId, input.escalationId, input.agent, 'escalation.claimed', input.actor);
  }

  /** WAITING → CLAIMED with an admin-assigned agent identity. */
  async assign(input: { orgId: string; escalationId: string; agent: string; actor: string }): Promise<Escalation> {
    return this.transitionToClaimed(input.orgId, input.escalationId, input.agent, 'escalation.assigned', input.actor);
  }

  private async transitionToClaimed(
    orgId: string,
    escalationId: string,
    agent: string,
    auditAction: string,
    actor: string,
  ): Promise<Escalation> {
    if (!agent.trim()) {
      throw ApiError.validation({ agent: 'must not be empty' });
    }
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(escalations)
        .where(and(eq(escalations.organizationId, orgId), eq(escalations.id, escalationId)))
        .for('update')
        .limit(1);
      const escalation = rows[0];
      if (!escalation) {
        throw ApiError.notFound('escalation');
      }
      if (escalation.state === 'CLAIMED') {
        if (escalation.claimedBy === agent) {
          return escalation; // replay
        }
        throw ApiError.conflict('escalation already claimed', { claimed_by: escalation.claimedBy });
      }
      if (escalation.state !== 'WAITING') {
        throw ApiError.conflict('escalation is not claimable', { state: escalation.state });
      }
      const updated = await tx
        .update(escalations)
        .set({ state: 'CLAIMED', claimedBy: agent.trim().slice(0, 128), claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(escalations.id, escalation.id))
        .returning();
      await recordOutboxEvent(tx, {
        aggregateType: 'conversation',
        aggregateId: escalation.conversationId,
        organizationId: orgId,
        eventType: 'conversation.escalation.claimed',
        partitionKey: escalation.conversationId,
        payload: { conversation_id: escalation.conversationId, escalation_id: escalation.id, claimed_by: agent.trim().slice(0, 128) },
      });
      await this.audit.add({
        action: auditAction,
        resourceType: 'escalation',
        resourceId: escalation.id,
        actorType: 'account',
        actorId: actor,
        tenantId: orgId,
        details: { agent: agent.trim().slice(0, 128) },
      });
      return updated[0];
    });
  }

  /**
   * CLAIMED → RESOLVED: the escalation closes and the auto-responder resumes
   * (conversation status → 'active', FL-1.7d).
   */
  async resolve(input: { orgId: string; escalationId: string; note?: string; actor: string }): Promise<Escalation> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(escalations)
        .where(and(eq(escalations.organizationId, input.orgId), eq(escalations.id, input.escalationId)))
        .for('update')
        .limit(1);
      const escalation = rows[0];
      if (!escalation) {
        throw ApiError.notFound('escalation');
      }
      if (escalation.state === 'RESOLVED') {
        return escalation; // replay
      }
      if (escalation.state !== 'CLAIMED') {
        throw ApiError.conflict('escalation must be claimed before resolution', { state: escalation.state });
      }
      const now = new Date().toISOString();
      const updated = await tx
        .update(escalations)
        .set({
          state: 'RESOLVED',
          resolvedAt: now,
          resolutionNote: input.note?.slice(0, 2048) ?? null,
          updatedAt: now,
        })
        .where(eq(escalations.id, escalation.id))
        .returning();

      // Resume the auto-responder (FL-1.7d) — only if no other escalation
      // opened in the meantime.
      const stillOpen = await tx
        .select({ id: escalations.id })
        .from(escalations)
        .where(
          and(
            eq(escalations.organizationId, input.orgId),
            eq(escalations.conversationId, escalation.conversationId),
            inArray(escalations.state, ['WAITING', 'CLAIMED']),
          ),
        )
        .limit(1);
      if (stillOpen.length === 0) {
        const conv = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, escalation.conversationId))
          .for('update')
          .limit(1);
        if (conv.length > 0 && conv[0].status === 'escalated') {
          await tx
            .update(conversations)
            .set({ status: 'active', version: conv[0].version + 1, updatedAt: now })
            .where(eq(conversations.id, escalation.conversationId));
        }
      }

      await recordOutboxEvent(tx, {
        aggregateType: 'conversation',
        aggregateId: escalation.conversationId,
        organizationId: input.orgId,
        eventType: 'conversation.escalation.resolved',
        partitionKey: escalation.conversationId,
        payload: { conversation_id: escalation.conversationId, escalation_id: escalation.id },
      });
      await this.audit.add({
        action: 'escalation.resolved',
        resourceType: 'escalation',
        resourceId: escalation.id,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: { conversation_id: escalation.conversationId },
      });
      return updated[0];
    });
  }

  /**
   * Human-agent reply — the ONE message entry point's service-participant
   * sibling: same TX discipline (row lock, sequence allocation, durable
   * message), but NO run is created and NO auto-responder is triggered.
   * Rendered distinctly to the end user via content.author = 'human_agent'.
   */
  async agentReply(input: {
    orgId: string;
    conversationId: string;
    escalationId: string;
    agent: string;
    text: string;
  }): Promise<{ message_id: string; sequence: number }> {
    const text = input.text.trim().slice(0, 8192);
    if (!text) {
      throw ApiError.validation({ text: 'must not be empty' });
    }
    return this.db.withOrg(input.orgId, async (tx) => {
      await this.lockOpenEscalation(tx, input.orgId, input.conversationId, input.escalationId);
      const convRows = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update')
        .limit(1);
      if (convRows.length === 0) {
        throw ApiError.notFound('conversation');
      }
      const sequence = await nextMessageSequence(tx, input.conversationId);
      const messageId = uuidv7();
      await tx.insert(messages).values({
        id: messageId,
        conversationId: input.conversationId,
        organizationId: input.orgId,
        sequence,
        role: 'assistant',
        content: { text, author: 'human_agent', escalation_id: input.escalationId },
        createdBy: input.agent.slice(0, 128),
      });
      // Channel relay (FL-1.7b) — the outbound consumer forwards
      // service-authored messages to the bound platform (window policy kept).
      await recordOutboxEvent(tx, {
        aggregateType: 'message',
        aggregateId: messageId,
        organizationId: input.orgId,
        eventType: 'message.created',
        partitionKey: input.conversationId,
        payload: { message_id: messageId, conversation_id: input.conversationId, author: 'human_agent' },
      });
      return { message_id: messageId, sequence };
    });
  }

  private async lockOpenEscalation(
    tx: NodePgDatabase,
    orgId: string,
    conversationId: string,
    escalationId: string,
  ): Promise<Escalation> {
    const rows = await tx
      .select()
      .from(escalations)
      .where(
        and(
          eq(escalations.organizationId, orgId),
          eq(escalations.id, escalationId),
          eq(escalations.conversationId, conversationId),
        ),
      )
      .for('update')
      .limit(1);
    const escalation = rows[0];
    if (!escalation) {
      throw ApiError.notFound('escalation');
    }
    if (escalation.state === 'RESOLVED') {
      throw ApiError.conflict('escalation is resolved; replies belong to the assistant', { state: escalation.state });
    }
    return escalation;
  }
}

/**
 * P0-3 — immutable brief-at-handoff shape. Bounded (summary ≤4k, last
 * customer message ≤2k) so the row stays small; nulls where data is absent
 * (no summary yet, no open run) rather than invented text. Pure — tested.
 */
export function buildEscalationBrief(input: {
  summary: string | null;
  summarySequence: number | null;
  messageCount: number;
  lastUserText: string | null;
  openRun: { id: string; state: string } | null;
}): Record<string, unknown> {
  return {
    summary: input.summary === null ? null : input.summary.slice(0, 4000),
    summary_sequence: input.summarySequence,
    message_count: Math.max(0, Math.floor(input.messageCount)),
    last_user_text: input.lastUserText === null ? null : input.lastUserText.slice(0, 2000),
    open_run: input.openRun,
  };
}
