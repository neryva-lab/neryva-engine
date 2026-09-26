/**
 * Data-access repository (P3) — the persistence port for the compliance
 * read/write surface of `LifecycleService` (9.7/9.8).
 *
 * Writes are platform-plane (`withBypass` on the pg lane): data-access
 * records describe privileged reads that may originate outside any single
 * tenant session, and tombstones are consulted globally by id. Both tables
 * carry their own `organization_id` predicate where the row is tenant-owned.
 */
export interface IDataAccessRepository {
  /**
   * Append a data-access record. Length caps are enforced by the repository
   * (actor 128, justification 512, trace 64), exactly as the service did.
   */
  recordAccess(input: {
    orgId: string | null;
    actorType: string;
    actorId: string;
    accessType: string;
    resourceType: string;
    resourceId?: string;
    justification?: string;
    traceId?: string;
  }): Promise<void>;

  /**
   * Tombstone read for console paths (9.8). Returns the purge reason when
   * the (resourceType, resourceId) pair was tombstoned, else null. The
   * service maps a hit to the typed 410.
   */
  tombstoneFor(resourceType: string, resourceId: string): Promise<{ reason: string } | null>;
}
