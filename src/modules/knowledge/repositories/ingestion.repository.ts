/**
 * Ingestion repository (P3) — the persistence port for the WHOLE indexing
 * stage (`IngestionService`).
 *
 * A single method owns the entire stage, because the stage IS the unit of
 * work: one TX takes a parsed document from the worker to a queryable set of
 * chunks and vectors. Splitting it would leave re-ingest half-applied (new
 * version without chunks, or chunks pointing at a rolled-back version).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: every method takes the organization id explicitly (first
 * parameter or inside `input`). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - parsing the artifact bytes into chunks (extraction stage)
 * - computing embedding vectors (the embedding service) — vectors arrive as
 *   PRE-COMPUTED inputs; the repository performs no network I/O
 * - choosing `targetDocumentId` for re-ingest (the service decides; the repo
 *   only takes the row lock on it)
 */
export interface IIngestionRepository {
  /**
   * The whole INDEXING stage, one TX:
   * 1. `SELECT … FOR UPDATE` on the re-ingest target document when
   *    `targetDocumentId` is set (serializes concurrent re-syncs of the same
   *    document).
   * 2. Dedupe the document row by `sourceArtifactId` — `onConflictDoNothing`
   *    then read-back, so a retried session converges on the same document.
   * 3. Upsert the `connector_documents` mapping when `connectorRef` is set.
   * 4. Mint `max(version) + 1` for the document, insert the
   *    `document_versions` row `onConflictDoNothing` then read back by
   *    `(documentId, sha256, parserVersion)`; identical content under an
   *    existing version means delete+reinsert its chunks (rebuild, not
   *    duplicate).
   * 5. Insert the chunk rows and their embedding rows (vectors are
   *    PRE-COMPUTED inputs — the repo never calls the embedding service).
   * 6. Session → INDEXING.
   *
   * Returns the document id, the version row id, and the minted version.
   */
  indexDocumentVersion(input: {
    orgId: string;
    sessionId: string;
    artifactId: string;
    targetDocumentId: string | null;
    sourceSlug: string;
    title: string;
    connectorRef: { accountId: string; provider: string; externalId: string } | null;
    contentSha256: Uint8Array;
    parserVersion: string;
    embeddingModel: string;
    chunks: Array<{
      sequence: number;
      byteStart: number;
      byteEnd: number;
      chunkHash: string;
      text: string;
      vector: number[];
    }>;
    at: Date;
  }): Promise<{ documentId: string; versionId: string; version: number }>;
}
