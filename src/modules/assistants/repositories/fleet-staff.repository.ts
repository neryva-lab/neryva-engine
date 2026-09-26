/**
 * Fleet-staff repository (P3) — the persistence port for staff-scoped,
 * platform-wide template operations (the staff controllers for template
 * platform blocks and cross-org install inventory).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: these tables are GLOBAL and staff-scoped — no `orgId`
 * anywhere (the pg implementation uses root posture; the mongo
 * implementation unscoped collections). `listInstallsBySlug` reads the
 * tenant-owned `assistant_installs` across orgs for inventory purposes;
 * it is BOUNDED (server-side row cap) and returns plain
 * `Record<string, unknown>` rows — the staff layer projects what it needs.
 *
 * Row types are imported as *types only* from the module's
 * template-blocks schema — the interface carries no drizzle runtime
 * dependency. Both implementations return objects matching these shapes
 * (the MongoDB implementation maps BSON documents, including Binary
 * subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - staff authorization (guards above this layer)
 * - input validation (slug format, limit clamps)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - 409/404 mapping (null results mean "no active block" / "none active";
 *   the caller maps to the status code)
 */
import type { TemplatePlatformBlock } from '../template-blocks.schema';

export interface IFleetStaffRepository {
  /**
   * Place a platform-wide block for the slug. Returns null when an active
   * block already exists (caller maps to 409).
   */
  placePlatformBlock(input: {
    slug: string;
    reason: string;
    createdBy: string;
  }): Promise<TemplatePlatformBlock | null>;

  /**
   * Lift the active platform-wide block for the slug. Returns null when
   * none is active (caller maps to 404).
   */
  liftPlatformBlock(input: {
    slug: string;
    liftedBy: string;
  }): Promise<TemplatePlatformBlock | null>;

  listPlatformBlocks(): Promise<TemplatePlatformBlock[]>;

  /**
   * Cross-org install-base inventory for a template slug (optionally
   * pinned to a version). Bounded server-side; returns plain rows.
   */
  listInstallsBySlug(
    slug: string,
    templateVersion?: string,
  ): Promise<Array<Record<string, unknown>>>;

  /**
   * Recent `template.registry_synced` audit rows, newest first.
   * Bounded by `limit`.
   */
  listRegistrySyncs(limit?: number): Promise<Array<Record<string, unknown>>>;
}
