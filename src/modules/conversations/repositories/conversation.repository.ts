/**
 * Conversation repository (P3) — the persistence port for the conversation
 * aggregate root (`ConversationsService` lifecycle/content operations and
 * `McpAuthorityService.saveConversationSummary`).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation applies
 * it via `DbService.withOrg` (RLS); the MongoDB implementation applies it as
 * an explicit `organization_id` predicate on every tenant collection access
 * (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, limit clamps)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - the Redis advisory quota plane (not a database concern)
 * - retention tombstone checks (`RetentionPurgeService`)
 */
import type { Conversation, Message } from '../schema';

export interface IConversationRepository {
  /**
   * Create a conversation (assistant-exists check + participant row in one TX).
   */
  createConversation(input: {
    orgId: string;
    assistantId: string;
    createdBy: string;
    channelBinding?: Record<string, unknown>;
    participantScope?: string;
  }): Promise<Conversation>;

  /** Raw row read; the service applies the soft-delete → null mapping. */
  getConversation(orgId: string, conversationId: string): Promise<Conversation | null>;

  listConversations(
    orgId: string,
    opts?: { limit?: number; assistantId?: string },
  ): Promise<Conversation[]>;

  /**
   * Optimistic-concurrency status flip (row lock + version CAS).
   * Throws notFound when the conversation is missing, conflict on a stale version.
   */
  transitionStatus(
    orgId: string,
    conversationId: string,
    status: 'active' | 'archived' | 'deleted',
    expectedVersion?: number,
  ): Promise<Conversation>;

  /** Set the human-facing title (already trimmed/sliced by the service). */
  setTitle(input: {
    orgId: string;
    conversationId: string;
    title: string;
    actor: string;
  }): Promise<Conversation>;

  listMessages(
    orgId: string,
    conversationId: string,
    opts?: { afterSequence?: number; limit?: number; includeSuperseded?: boolean },
  ): Promise<{ messages: Message[]; next_cursor: number | null }>;

  setPinned(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    pinned: boolean;
    actor: string;
  }): Promise<Message>;

  /**
   * Conversation compaction: idempotent per (conversation_id, source_sequence);
   * same content under the same key replays, different content under the same
   * key is a conflict, not an overwrite.
   */
  saveConversationSummary(input: {
    orgId: string;
    conversationId: string;
    sourceSequence: number;
    summary: string;
    tokenCount: number;
    modelId?: string;
    callerScope: string;
    idempotencyKey: string;
  }): Promise<{ summaryId: string; duplicate: boolean }>;
}
