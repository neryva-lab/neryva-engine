import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  conversations,
  conversationParticipants,
  conversationSummaries,
  messages,
} from '../schema';
import type { Conversation, Message } from '../schema';
import type { IConversationRepository } from './conversation.repository';

/**
 * PostgreSQL implementation of `IConversationRepository` (P3).
 *
 * Mechanical move of the `ConversationsService` lifecycle/content units
 * (and `McpAuthorityService.saveConversationSummary`): every method owns its
 * transaction via `DbService.withOrg`, runs all reads/writes inside it, and
 * commits or rolls back as one. No transaction handle leaks through this
 * interface.
 *
 * What stays OUT (still the caller's job): input validation (`assertUuid`,
 * limit clamps — the caller pre-normalizes), tracing spans, audit writes
 * (replayed by the service from inputs + results), the Redis advisory quota
 * plane, and retention tombstone checks.
 */
export class PgConversationRepository implements IConversationRepository {
  constructor(private readonly db: DbService) {}

  /** Create a conversation (assistant-exists check + participant row in one TX). */
  async createConversation(input: {
    orgId: string;
    assistantId: string;
    createdBy: string;
    channelBinding?: Record<string, unknown>;
    participantScope?: string;
  }): Promise<Conversation> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const exists = await tx.execute(
        sql`select 1 from assistants where id = ${input.assistantId}::uuid limit 1`,
      );
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
  }

  /** Raw row read; the service applies the soft-delete → null mapping. */
  async getConversation(orgId: string, conversationId: string): Promise<Conversation | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listConversations(
    orgId: string,
    opts?: { limit?: number; assistantId?: string },
  ): Promise<Conversation[]> {
    const limit = clampLimit(opts?.limit);
    // Soft-deleted conversations never appear in lists (see setConversationStatus).
    const conditions = [
      eq(conversations.organizationId, orgId),
      ne(conversations.status, 'deleted'),
    ];
    if (opts?.assistantId) {
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

  /**
   * Optimistic-concurrency status flip (row lock + version CAS).
   * Throws notFound when the conversation is missing, conflict on a stale version.
   */
  async transitionStatus(
    orgId: string,
    conversationId: string,
    status: 'active' | 'archived' | 'deleted',
    expectedVersion?: number,
  ): Promise<Conversation> {
    return this.db.withOrg(orgId, async (tx) => {
      const current = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update')
        .limit(1);
      if (current.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (expectedVersion !== undefined && current[0].version !== expectedVersion) {
        throw ApiError.conflict('stale conversation version', {
          expected: expectedVersion,
          actual: current[0].version,
        });
      }
      const updated = await tx
        .update(conversations)
        .set({ status, version: current[0].version + 1, updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, conversationId))
        .returning();
      return updated[0];
    });
  }

  /** Set the human-facing title (already trimmed/sliced by the service). */
  async setTitle(input: {
    orgId: string;
    conversationId: string;
    title: string;
    actor: string;
  }): Promise<Conversation> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(conversations)
        .set({ title: input.title, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.organizationId, input.orgId),
          ),
        )
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('conversation');
      }
      return rows[0];
    });
  }

  async listMessages(
    orgId: string,
    conversationId: string,
    opts?: { afterSequence?: number; limit?: number; includeSuperseded?: boolean },
  ): Promise<{ messages: Message[]; next_cursor: number | null }> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.afterSequence ?? 0;
    const conditions = [eq(messages.conversationId, conversationId), gt(messages.sequence, after)];
    // FL-3.3 — the active branch hides superseded rows; `include_superseded`
    // serves the branch history (the replacement pointer is on each row).
    if (!opts?.includeSuperseded) {
      conditions.push(isNull(messages.supersededBy));
    }
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(asc(messages.sequence))
        .limit(limit),
    );
    const nextCursor = rows.length === limit ? rows[rows.length - 1].sequence : null;
    return { messages: rows, next_cursor: nextCursor };
  }

  async setPinned(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    pinned: boolean;
    actor: string;
  }): Promise<Message> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(messages)
        .set({
          pinnedAt: input.pinned ? new Date().toISOString() : null,
          pinnedBy: input.pinned ? input.actor.slice(0, 128) : null,
        })
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.conversationId, input.conversationId),
            isNull(messages.supersededBy),
          ),
        )
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('message');
      }
      return rows[0];
    });
  }

  /**
   * Conversation compaction (contract v1.1 SaveConversationSummary, moved
   * from `McpAuthorityService`): idempotent per (conversation_id,
   * source_sequence); a different digest under the same key is a conflict,
   * not an overwrite. The caller validates `sourceSequence` and pre-slices
   * the summary bound; the slice here is idempotent so it stays exact either
   * way.
   */
  async saveConversationSummary(input: {
    orgId: string;
    conversationId: string;
    sourceSequence: number;
    summary: string;
    tokenCount: number;
    modelId?: string;
    callerScope: string;
    idempotencyKey: string;
  }): Promise<{ summaryId: string; duplicate: boolean }> {
    const summary = input.summary.slice(0, 8192);
    return this.db.withOrg(input.orgId, async (tx) => {
      const conv = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.organizationId, input.orgId),
          ),
        )
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      // Idempotency anchor: same key + same content → replay; different
      // content → conflict. The conversation row is the natural scope here.
      const claimed = await tx
        .insert(conversationSummaries)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          sourceSequence: input.sourceSequence,
          summary,
          tokenCount: Math.max(0, Math.floor(input.tokenCount)),
          modelId: input.modelId?.slice(0, 128) ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (claimed.length > 0) {
        return { summaryId: claimed[0].id, duplicate: false };
      }
      const existing = await tx
        .select({ id: conversationSummaries.id, summary: conversationSummaries.summary })
        .from(conversationSummaries)
        .where(
          and(
            eq(conversationSummaries.conversationId, input.conversationId),
            eq(conversationSummaries.sourceSequence, input.sourceSequence),
          ),
        )
        .limit(1);
      if (existing.length > 0 && existing[0].summary === summary) {
        return { summaryId: existing[0].id, duplicate: true };
      }
      throw ApiError.conflict(
        'summary already exists for this source sequence with different content',
      );
    });
  }
}

/** Limit normalization shared by the list reads (the caller validates input). */
function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return 50;
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}
