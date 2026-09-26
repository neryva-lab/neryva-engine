/**
 * Retrieval-ACL repository (P3) — the persistence port for the
 * document-level retrieval access control list (`retrieval_acl`).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
export interface IRetrievalAclRepository {
  /**
   * Grant document visibility: a single plain INSERT of one grant row
   * (legacy semantics — the old service code was `insert …
   * onConflictDoNothing()` with no conflict target, i.e. a plain insert;
   * there is no unique constraint on the resource key, only the
   * non-unique `ix_retrieval_acl_resource` index). No dedup, no replace:
   * repeated grants accumulate rows, and the retrieval join admits on ANY
   * matching row.
   *
   * `visibility: 'organization'` = every caller in the org; `'private'` =
   * only `scopeAccountId`. A null `scopeAccountId` with `'private'`
   * visibility is a service-level validation error — the repository writes
   * exactly what it is given.
   */
  grantDocumentAccess(input: {
    orgId: string;
    documentId: string;
    visibility: 'organization' | 'private';
    scopeAccountId: string | null;
  }): Promise<void>;
}
