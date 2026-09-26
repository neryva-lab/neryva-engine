/**
 * Policy-snapshot repository (P3) — the persistence port for the
 * `policy_snapshots` aggregate (content-addressed policy snapshots written
 * in the publish TX and pinned by run acceptance).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * `synthesizeSnapshotForVersion` deliberately owns its OWN transaction and
 * COMMITS before the caller's TX pins it, rather than sharing the caller's
 * unit of work: the snapshot is idempotent per (version, content hash), the
 * manifest-resolution reads that build it must not hold the caller's wide
 * publish lock (lock-ordering hazard on the same aggregate rows), and the
 * caller's pin step must be able to read the committed row in its own
 * read-consistent snapshot. So: synthesize commits first, the caller pins
 * after.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `organization_id` predicate on every tenant
 * collection access (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - snapshot hashing (the service computes the content hash; the
 *   repository only matches/inserts on it)
 */
import type { PolicySnapshot } from '../schema';

export interface IPolicySnapshotRepository {
  /** Raw row read; returns null when the snapshot is missing or foreign. */
  getSnapshot(orgId: string, snapshotId: string): Promise<PolicySnapshot | null>;

  /**
   * Content-addressed read: the snapshot row matching the version's LIVE
   * content hash. One read-consistent unit of work — the version read and
   * the snapshot lookup see the same point in time.
   */
  getSnapshotForVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<PolicySnapshot | null>;

  /**
   * Idempotent per (version, content hash): builds the snapshot for the
   * version (manifest-resolution reads run inside this unit of work) and
   * inserts it only if no row for that content hash exists yet. Owns its
   * own transaction and commits before the caller's TX pins the snapshot
   * (see header note).
   */
  synthesizeSnapshotForVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
  }): Promise<void>;
}
