/**
 * Artifact repository (P3) — the persistence port for artifact reads
 * (`ArtifactsService`, claim-check facade).
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
 *
 * (Intentionally narrow: artifact lifecycle writes live in
 * `IUploadSessionRepository` / `IConnectorIngestStagingRepository`, which own
 * the transactions those writes participate in. This port is the read side.)
 */
import type { Artifact } from '../schema';

export interface IArtifactRepository {
  /** Read one artifact, or null when not found. */
  findById(orgId: string, artifactId: string): Promise<Artifact | null>;
}
