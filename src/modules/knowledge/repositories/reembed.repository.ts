/**
 * Re-embed repository (P3) — the persistence port for the embedding-model
 * migration worker (`ReEmbedService`, FL-2.2).
 *
 * The worker recomputes chunk vectors under a new model and swaps them in
 * per document. Each method owns its transaction: the implementation opens
 * the unit of work, runs all reads/writes inside it, and commits or rolls
 * back as one. No transaction handle or callback leaks through this
 * interface — callers get plain domain results.
 *
 * Tenant discipline: `listReadyOrgIds` is BYPASS (the worker enumerates orgs
 * itself); every other method takes the organization id explicitly (first
 * parameter or inside `input`). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service/worker's job):
 * - computing the new vectors (they arrive pre-computed; the repository
 *   performs no network I/O and never calls the embedding service)
 * - choosing the effective model per org (worker policy)
 */
export interface IReEmbedRepository {
  /**
   * BYPASS. Organization ids whose knowledge is eligible for re-embedding,
   * capped at `limit`. Org enumeration is the worker's job — no tenant
   * context exists yet at this point.
   */
  listReadyOrgIds(limit: number): Promise<string[]>;

  /**
   * Documents in the org whose active vectors were NOT computed with
   * `effectiveModel` (id only), capped at `batch`. The worker drives the
   * per-document swap from this list.
   */
  listPendingDocuments(
    orgId: string,
    effectiveModel: string,
    batch: number,
  ): Promise<Array<{ id: string }>>;

  /** Chunk ids + texts for one document (the worker embeds the texts). */
  listDocumentChunks(
    orgId: string,
    documentId: string,
  ): Promise<Array<{ chunkId: string; text: string }>>;

  /**
   * ATOMIC per-document embedding swap, one TX:
   * 1. Insert the target-model embedding rows for every chunk (vectors are
   *    PRE-COMPUTED inputs).
   * 2. Parity count check — the inserted row count must equal the chunk
   *    count; mismatch throws (retryable) so a half-swapped document can
   *    never publish.
   * 3. Flip `documents.embeddingModel` to `targetModel`.
   * 4. Sweep stale-model embedding rows for the document.
   *
   * Zero-chunk documents flip directly (steps 1–2 are vacuous, 3–4 still
   * run). Returns the chunk count and how many stale-model rows were swept.
   */
  swapDocumentEmbeddings(input: {
    orgId: string;
    documentId: string;
    targetModel: string;
    vectors: Array<{ chunkId: string; vector: number[] }>;
    at: Date;
  }): Promise<{ chunks: number; staleModelsSwept: number }>;
}
