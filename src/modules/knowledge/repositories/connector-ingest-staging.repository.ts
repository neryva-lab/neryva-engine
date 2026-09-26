/**
 * Connector-ingest-staging repository (P3) — the persistence port for the
 * connector sync's document staging (`ConnectorsService`).
 *
 * Synced content flows through the existing upload-session pipeline: the
 * connector stages an artifact + a session in state UPLOADED, and the
 * ingestion worker picks it up like any other upload. This port owns that
 * staging write.
 *
 * The method owns its transaction: both inserts commit together (an artifact
 * without its session is unclaimable; a session without its artifact violates
 * the FK). No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: the organization id is explicit (inside `draft` via
 * `StagedSourceDocument`). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on the tenant collection writes.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - fetching bytes from the external source (network)
 * - minting the tenant-bound object key and uploading to object storage
 * - the session's source-ACL intent (carried on the draft's session row)
 */
import type { StagedSourceDocument } from './repository-types';

export interface IConnectorIngestStagingRepository {
  /**
   * ATOMIC staging, one TX: `artifacts.insert` + `upload_sessions.insert`
   * with the session in state UPLOADED. The draft's artifact and session
   * rows are service-composed (ids, object key, byte length, sha256,
   * connector provenance) — the repository only owns the atomicity.
   */
  stageDocument(orgId: string, draft: StagedSourceDocument): Promise<void>;
}
