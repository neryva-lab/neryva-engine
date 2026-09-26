/**
 * Memory-item repository (P3) — the persistence port for the `memory_items`
 * aggregate (`MemoryService` and the retrieval read path).
 *
 * One aggregate, one repo: ALL `memory_items` access — writes AND the
 * retrieval-time reads — goes through this port, so the aggregate's
 * invariants (tombstone predicate, approval visibility, temporal validity)
 * live in exactly one place.
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation applies
 * it via `DbService.withOrg` (RLS); the MongoDB implementation applies it as
 * an explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - computing embeddings (they arrive pre-computed)
 * - proposal lifecycle (`IMemoryDecisionRepository` owns the approval
 *   transition)
 * - audit writes (replayed by the service from inputs + results)
 */
import type { MemoryItem } from '../schema';
import type {
  LegalHoldSummary,
  MemoryItemDraft,
  MemoryPolicySettings,
  MemoryScope,
} from './repository-types';

export interface IMemoryItemRepository {
  /**
   * Org memory policy from org_settings.preferences (cross-module read,
   * documented), using the legacy keys `memory_pii_scrubbing` /
   * `memory_ttl_default_seconds` with the legacy fail-open parse:
   * `scrub` must be one of off|redact|block (anything else → 'off');
   * TTL must be an integer in [3600, 315360000] (anything else → null).
   * Null when the settings row or the preferences object is absent — the
   * service applies the `{ scrub: 'off', ttlSeconds: null }` fallback.
   */
  readMemoryPolicy(orgId: string): Promise<MemoryPolicySettings | null>;

  /**
   * Active org-scope legal holds (cross-module read, documented): an
   * active hold blocks the DSR purge, mirroring the retention workflow's
   * check_holds gate. The service reports the first hold's id.
   */
  listActiveLegalHolds(orgId: string): Promise<LegalHoldSummary[]>;

  /**
   * Insert a memory item from a service-composed draft. The repository
   * applies `orgId`, mints nothing else the draft does not already carry.
   */
  insertItem(orgId: string, draft: MemoryItemDraft): Promise<MemoryItem>;

  /**
   * List non-deleted items for the org, filtered by scope type/id and the
   * user caller id, capped at `limit`. Ordered newest-first.
   */
  listItems(
    orgId: string,
    filter: { scopeType?: string; scopeId?: string; userCallerId?: string; limit: number },
  ): Promise<MemoryItem[]>;

  /**
   * Replace content + embedding of a live item. The `isNull(deletedAt)`
   * predicate is part of the update — throws notFound when the item is
   * missing or already tombstoned. `embedding` is pre-computed by the
   * service; the repository never embeds.
   */
  updateItemContent(
    orgId: string,
    memoryId: string,
    input: { content: string; embedding: number[]; embeddingModel: string },
  ): Promise<MemoryItem>;

  /**
   * Tombstone an item (`deletedAt` + `invalidAt` stamped together).
   * Throws notFound when the item is missing or already tombstoned.
   */
  softDeleteItem(orgId: string, memoryId: string): Promise<void>;

  /**
   * Purge items matching a content pattern — a SINGLE atomic
   * `UPDATE … WHERE content LIKE pattern RETURNING id`, bounded `LIMIT 1000`.
   * Never split into select-then-update (concurrent purges would double-
   * count or miss rows). LIKE-escaping of the raw query stays in the
   * SERVICE; this method receives the already-escaped pattern.
   */
  purgeByContent(orgId: string, escapedLikePattern: string): Promise<string[]>;

  /**
   * Vector search over approved, non-deleted memories. `vectorLiteral` is
   * the pre-computed query vector as a SQL literal; `queryModel` scopes the
   * leg to the matching `embedding_model` (NULL-model legacy rows still
   * participate); `scopes` are the caller's memory scopes.
   */
  searchApprovedMemoriesVector(input: {
    orgId: string;
    vectorLiteral: string;
    queryModel: string;
    scopes: MemoryScope[];
    limit: number;
  }): Promise<MemoryItem[]>;

  /**
   * Non-vector listing of approved, non-deleted memories for the given
   * scopes (recency-ordered), capped at `limit`.
   */
  listApprovedMemoriesForScopes(
    orgId: string,
    scopes: MemoryScope[],
    limit: number,
  ): Promise<MemoryItem[]>;

  /**
   * Approved, non-deleted memories for the run-context assembly read path:
   * conversation scope first, then organization fallback, capped at `limit`.
   */
  listApprovedMemories(input: {
    orgId: string;
    conversationId?: string;
    limit: number;
  }): Promise<MemoryItem[]>;
}
