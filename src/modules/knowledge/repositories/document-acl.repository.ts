/**
 * Document-ACL repository (P3) — the persistence port for the READY stage
 * (`IngestionService`): the document becomes queryable and its access
 * posture is fixed in one atomic transition.
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
 * Best-effort semantics are preserved INSIDE the transaction (e.g. a
 * principal row that fails to upsert aborts the whole stage — fail-closed,
 * never half-published), but no failure is swallowed: the repository throws
 * and the worker retries.
 */
export interface IDocumentAclRepository {
  /**
   * The whole READY stage, one TX:
   * 0. Upload session → `READY` (the READY-stage transaction boundary:
   *    the flip is the FIRST statement of this transaction, so a failure
   *    later in the stage rolls it back atomically).
   * 1. Document → `ready`, stamping `embeddingModel`.
   * 2. Default org `retrieval_acl` row (`onConflictDoNothing`) — the org
   *    visibility baseline every document carries.
   * 3. Source-ACL replace set from `sourceAcl`:
   *    - `mode: 'open'` → delete any existing `document_source_acls`
   *      restrictions (no allow-list = org posture).
   *    - `mode: 'restricted'` → upsert `external_principals`
   *      (`onConflictDoUpdate` kind/email/updatedAt) + auto-link principals
   *      to accounts by verified email lookup + `external_identity_links`
   *      `onConflictDoNothing` + delete+reinsert `document_source_acls`.
   *
   * Returns the document id the session's document converged on (null only
   * when the document row could not be resolved — the caller fails the
   * session rather than marking it READY).
   */
  publishDocumentReady(input: {
    orgId: string;
    sessionId: string;
    artifactId: string;
    targetDocumentId: string | null;
    embeddingModel: string;
    sourceAcl: {
      mode: 'open' | 'restricted';
      principals: Array<{ kind: string; id: string; email?: string }>;
    } | null;
    connectorProvider: string;
    at: Date;
  }): Promise<{ documentId: string | null }>;

  /** The latest published version number of a document (null when none). */
  latestVersion(orgId: string, documentId: string): Promise<number | null>;
}
