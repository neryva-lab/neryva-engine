import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { claimIdempotency, completeIdempotency, IdempotencyScope } from '../../common/http/idempotency-records';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { uuidv7 } from '../../common/ids/uuidv7';
import {
  conversations,
  conversationParticipants,
  messages,
  runEvents,
  runs,
  Conversation,
  Message,
  Run,
  RunEvent,
  MAX_MESSAGE_TEXT_LENGTH,
} from './schema';
import { assertRunTransition, isRunState, isTerminalRun } from './state-machine';

/**
 * Conversation plane service — Phase 4 (imp/ledger.md 4.7-4.10).
 *
 * The start-message transaction (4.7) is ONE PostgreSQL transaction:
 *   claim idempotency -> lock conversation row -> verify version/active-turn ->
 *   insert user message -> insert run ACCEPTED (pinned to the assistant's
 *   active published version + policy snapshot) -> insert outbox RunCreated ->
 *   bump conversation.version -> complete idempotency record -> commit.
 *
 * CommitRunResult (4.8) is the terminal analogue: assistant message + run
 * COMPLETED + terminal run_event + outbox in one transaction; a retry replays
 * the same message_id via `runs.result_message_id`.
 *
 * Sequence allocation and the one-active-turn policy are enforced by the DB
 * (conversation row lock + partial unique index), never in-process mutexes.
 */
@Injectable()
export class ConversationsService {
  private static readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ── Conversation lifecycle ───────────────────────────────────────────────

  async createConversation(input: {
    orgId: string;
    assistantId: string;
    createdBy: string;
    channelBinding?: Record<string, unknown>;
    participantScope?: string;
  }): Promise<Conversation> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.assistantId, 'assistantId');
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const exists = await tx.execute(sql`select 1 from assistants where id = ${input.assistantId}::uuid limit 1`);
      if (exists.rows.length === 0) {
        throw ApiError.notFound('assistant');
      }
      const inserted = await tx
        .insert(conversations)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          assistantId: input.assistantId,
          channelBinding: input.channelBinding ?? {},
          participantScope: input.participantScope ?? 'org',
        })
        .returning();
      const conversation = inserted[0];
      await tx.insert(conversationParticipants).values({
        id: uuidv7(),
        conversationId: conversation.id,
        organizationId: input.orgId,
        participantType: 'account',
        accountId: null,
        externalRef: input.createdBy,
      });
      return conversation;
    });
    await this.audit.add({
      action: 'conversation.created',
      resourceType: 'conversation',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId },
    });
    return row;
  }

  async getConversation(orgId: string, conversationId: string): Promise<Conversation | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1));
    return rows[0] ?? null;
  }

  async listConversations(orgId: string, opts?: { limit?: number; assistantId?: string }): Promise<Conversation[]> {
    assertUuid(orgId, 'orgId');
    const limit = clampLimit(opts?.limit);
    const conditions = [eq(conversations.organizationId, orgId)];
    if (opts?.assistantId) {
      assertUuid(opts.assistantId, 'assistantId');
      conditions.push(eq(conversations.assistantId, opts.assistantId));
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.updatedAt))
        .limit(limit),
    );
  }

  async setConversationStatus(orgId: string, conversationId: string, status: 'active' | 'archived', expectedVersion?: number): Promise<Conversation> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return this.db.withOrg(orgId, async (tx) => {
      const current = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update').limit(1);
      if (current.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (expectedVersion !== undefined && current[0].version !== expectedVersion) {
        throw ApiError.conflict('stale conversation version', { expected: expectedVersion, actual: current[0].version });
      }
      const updated = await tx
        .update(conversations)
        .set({ status, version: current[0].version + 1, updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, conversationId))
        .returning();
      return updated[0];
    });
  }

  // ── Start-message transaction (4.7) ─────────────────────────────────────

  async acceptMessage(input: {
    orgId: string;
    principalId: string;
    conversationId: string;
    content: Record<string, unknown>;
    expectedConversationVersion?: number;
    idempotencyKey?: string;
    traceId?: string;
  }): Promise<{ message_id: string; run_id: string; sequence: number; conversation_version: number; replay?: boolean }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    validateMessageContent(input.content);

    const requestHash = canonicalHash({
      conversation_id: input.conversationId,
      content: input.content,
      expected_conversation_version: input.expectedConversationVersion ?? null,
    });
    const scope: IdempotencyScope | undefined = input.idempotencyKey
      ? {
          organizationId: input.orgId,
          principalId: input.principalId,
          endpointFamily: 'messages:accept',
          idempotencyKey: input.idempotencyKey,
          requestHash,
        }
      : undefined;

    return this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return { ...(claim.response as { message_id: string; run_id: string; sequence: number; conversation_version: number }), replay: true };
        }
      }

      const result = await this.executeStartMessage(tx, input);
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return result;
    });
  }

  /** The atomic core — everything here commits or rolls back together. */
  private async executeStartMessage(
    tx: NodePgDatabase,
    input: {
      orgId: string;
      conversationId: string;
      content: Record<string, unknown>;
      expectedConversationVersion?: number;
      traceId?: string;
    },
  ): Promise<{ message_id: string; run_id: string; sequence: number; conversation_version: number }> {
    // Row lock serializes sequence allocation + the one-active-turn policy.
    const conv = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for('update').limit(1);
    if (conv.length === 0) {
      throw ApiError.notFound('conversation');
    }
    const conversation = conv[0];
    if (conversation.status !== 'active') {
      throw ApiError.conflict('conversation is not active', { status: conversation.status });
    }
    if (input.expectedConversationVersion !== undefined && conversation.version !== input.expectedConversationVersion) {
      throw ApiError.conflict('stale conversation version', {
        expected: input.expectedConversationVersion,
        actual: conversation.version,
      });
    }

    // Pin the assistant's active published version + policy snapshot at acceptance.
    const active = await tx.execute(sql`
      select av.id as version_id, ps.id as snapshot_id
      from assistants a
      join assistant_versions av on av.id = a.active_version_id
      join policy_snapshots ps on ps.assistant_version_id = av.id
      where a.id = ${conversation.assistantId}::uuid
      limit 1
    `);
    if (active.rows.length === 0) {
      throw ApiError.conflict('assistant has no published version with a policy snapshot');
    }
    const pin = active.rows[0] as { version_id: string; snapshot_id: string };

    const sequence = await nextMessageSequence(tx, input.conversationId);
    const messageId = uuidv7();
    const runId = uuidv7();

    await tx.insert(messages).values({
      id: messageId,
      conversationId: input.conversationId,
      organizationId: input.orgId,
      sequence,
      role: 'user',
      content: input.content,
      createdBy: null,
    });

    try {
      await tx.insert(runs).values({
        id: runId,
        organizationId: input.orgId,
        conversationId: input.conversationId,
        inputMessageId: messageId,
        assistantVersionId: pin.version_id,
        policySnapshotId: pin.snapshot_id,
        state: 'ACCEPTED',
      });
    } catch (err) {
      if (isUniqueViolation(err, 'uq_runs_one_active_per_conversation')) {
        throw ApiError.conflict('conversation already has an active run', { conversation_id: input.conversationId });
      }
      throw err;
    }

    await recordOutboxEvent(tx, {
      aggregateType: 'run',
      aggregateId: runId,
      organizationId: input.orgId,
      eventType: 'run.created',
      partitionKey: input.conversationId,
      payload: {
        run_id: runId,
        conversation_id: input.conversationId,
        message_id: messageId,
        assistant_version_id: pin.version_id,
        policy_snapshot_id: pin.snapshot_id,
      },
      traceId: input.traceId,
    });

    const nextVersion = conversation.version + 1;
    await tx.update(conversations).set({ version: nextVersion, updatedAt: new Date().toISOString() }).where(eq(conversations.id, input.conversationId));

    return { message_id: messageId, run_id: runId, sequence, conversation_version: nextVersion };
  }

  // ── Messages (read path) ─────────────────────────────────────────────────

  async listMessages(orgId: string, conversationId: string, opts?: { afterSequence?: number; limit?: number }): Promise<{ messages: Message[]; next_cursor: number | null }> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    const limit = clampLimit(opts?.limit);
    const after = opts?.afterSequence ?? 0;
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), gt(messages.sequence, after)))
        .orderBy(asc(messages.sequence))
        .limit(limit),
    );
    const nextCursor = rows.length === limit ? rows[rows.length - 1].sequence : null;
    return { messages: rows, next_cursor: nextCursor };
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  async getRun(orgId: string, runId: string): Promise<Run | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(runs).where(eq(runs.id, runId)).limit(1));
    return rows[0] ?? null;
  }

  async listRuns(orgId: string, conversationId: string, opts?: { limit?: number }): Promise<Run[]> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.organizationId, orgId), eq(runs.conversationId, conversationId)))
        .orderBy(desc(runs.acceptedAt))
        .limit(clampLimit(opts?.limit)),
    );
  }

  /**
   * Terminal atomic commit (4.8): assistant message + run COMPLETED +
   * terminal run_event + outbox row in ONE transaction. Idempotent: a retry
   * on a COMPLETED run replays the stored result_message_id.
   */
  async commitRunResult(input: { orgId: string; runId: string; content: Record<string, unknown>; actor: string }): Promise<{ message_id: string; run_id: string; replay: boolean }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    validateMessageContent(input.content);

    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.state === 'COMPLETED') {
        if (!run.resultMessageId) {
          throw ApiError.internal();
        }
        return { message_id: run.resultMessageId, run_id: run.id, replay: true };
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'COMPLETED');

      const sequence = await nextMessageSequence(tx, run.conversationId);
      const messageId = uuidv7();
      await tx.insert(messages).values({
        id: messageId,
        conversationId: run.conversationId,
        organizationId: input.orgId,
        sequence,
        role: 'assistant',
        content: input.content,
      });

      const insertedEvent = await tx
        .insert(runEvents)
        .values({
          id: uuidv7(),
          runId: run.id,
          organizationId: input.orgId,
          eventType: 'run.completed',
          payload: { message_id: messageId, terminal_reason: 'completed' },
          producerIdentity: 'engine:conversations',
        })
        .returning({ engineSequence: runEvents.engineSequence });

      await tx
        .update(runs)
        .set({
          state: 'COMPLETED',
          finishedAt: new Date().toISOString(),
          resultMessageId: messageId,
          lastEventSequence: insertedEvent[0].engineSequence,
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id));

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.completed',
        partitionKey: run.conversationId,
        payload: { run_id: run.id, conversation_id: run.conversationId, message_id: messageId },
      });

      return { message_id: messageId, run_id: run.id, replay: false };
    });
  }

  async cancelRun(input: { orgId: string; runId: string; reason?: string; actor: string }): Promise<Run> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    const canceled = await this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is already terminal', { state: run.state });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'CANCELED');

      const insertedEvent = await tx
        .insert(runEvents)
        .values({
          id: uuidv7(),
          runId: run.id,
          organizationId: input.orgId,
          eventType: 'run.canceled',
          payload: { reason: input.reason ?? 'canceled_by_principal' },
          producerIdentity: 'engine:conversations',
        })
        .returning({ engineSequence: runEvents.engineSequence });

      const updated = await tx
        .update(runs)
        .set({
          state: 'CANCELED',
          terminalReason: input.reason ?? 'canceled_by_principal',
          finishedAt: new Date().toISOString(),
          lastEventSequence: insertedEvent[0].engineSequence,
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.canceled',
        partitionKey: run.conversationId,
        payload: { run_id: run.id, conversation_id: run.conversationId, reason: input.reason ?? 'canceled_by_principal' },
      });
      return updated[0];
    });
    await this.audit.add({
      action: 'run.canceled',
      resourceType: 'run',
      resourceId: input.runId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { reason: input.reason ?? 'canceled_by_principal' },
    });
    return canceled;
  }

  async listRunEvents(orgId: string, runId: string, opts?: { afterSequence?: number; limit?: number }): Promise<{ events: RunEvent[]; next_cursor: number | null }> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
    const limit = clampLimit(opts?.limit);
    const after = opts?.afterSequence ?? 0;
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.engineSequence, after)))
        .orderBy(asc(runEvents.engineSequence))
        .limit(limit),
    );
    const nextCursor = rows.length === limit ? rows[rows.length - 1].engineSequence : null;
    return { events: rows, next_cursor: nextCursor };
  }
}

async function nextMessageSequence(tx: NodePgDatabase, conversationId: string): Promise<number> {
  const res = await tx.execute(sql`select coalesce(max(sequence), 0) + 1 as next from messages where conversation_id = ${conversationId}::uuid`);
  return Number((res.rows[0] as { next: string | number }).next);
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505' &&
    'constraint' in err &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}

function validateMessageContent(content: unknown): void {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw ApiError.validation({ content: 'must be an object' });
  }
  const text = (content as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw ApiError.validation({ content: 'must carry a non-empty text part' });
  }
  if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw ApiError.validation({ content: `text exceeds ${MAX_MESSAGE_TEXT_LENGTH} chars — use the artifact claim-check path` });
  }
  if (JSON.stringify(content).length > MAX_MESSAGE_TEXT_LENGTH * 2) {
    throw ApiError.validation({ content: 'content exceeds the bounded payload size' });
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return 50;
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}
