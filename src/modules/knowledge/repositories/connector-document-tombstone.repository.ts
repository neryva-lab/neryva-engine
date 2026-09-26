/**
 * Connector-document-tombstone repository (P3) — the persistence port for
 * source-deletion propagation (`ConnectorsService` delete handling).
 *
 * When a connector source deletes a document, the sync names the external
 * id; the `connector_documents` map resolves it to the engine document, and
 * the document is retired plus its source ACLs removed so retrieval can
 * never admit it again.
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
export interface IConnectorDocumentTombstoneRepository {
  /**
   * Resolve `(accountId, externalId)` → document id via the
   * `connector_documents` map. Its own transaction, matching today's split —
   * the lookup is a cheap pre-check callers make before deciding to act.
   * Null when unmapped.
   */
  lookupDocumentId(orgId: string, accountId: string, externalId: string): Promise<string | null>;

  /**
   * ATOMIC tombstone, one TX: map lookup → `documents.state = 'retired'` →
   * delete the document's `document_source_acls` rows. A retired document is
   * unreachable by retrieval; deleting its source ACLs removes the last
   * allow-list that could admit it. Returns false when the external id is
   * unmapped (nothing to tombstone — not an error).
   */
  tombstoneByExternalId(orgId: string, accountId: string, externalId: string): Promise<boolean>;
}
