/**
 * Control-block repository (P3) — the persistence port for the
 * `control_blocks` aggregate (`ControlBlocksService` kill-switch CRUD and
 * the five-level kill checks enforced at run acceptance).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results. `setBlock` performs the active-twin check and
 * the insert atomically: a concurrent twin insert conflicts, it never
 * creates two active blocks for the same target.
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
 * - input validation (`assertUuid`, target/reason shape checks)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - kill-level ordering and enforcement decisions (service policy)
 */
import type { ControlBlock, ControlBlockTarget } from '../schema';

export interface IControlBlockRepository {
  listBlocks(orgId: string): Promise<ControlBlock[]>;

  /**
   * Active-twin check + insert atomically; throws conflict when an active
   * block already exists for the same (targetType, targetName).
   */
  setBlock(input: {
    orgId: string;
    targetType: ControlBlockTarget;
    targetName: string;
    reason: string;
    expiresAt: string | null;
    createdBy: string;
  }): Promise<ControlBlock>;

  /**
   * Hard-delete the block row; throws notFound when the block is missing
   * or foreign.
   */
  clearBlock(input: { orgId: string; blockId: string }): Promise<{ ok: true }>;

  /** The active (non-expired) block for the target, if any. */
  findActiveBlock(
    orgId: string,
    targetType: ControlBlockTarget,
    targetName: string,
  ): Promise<ControlBlock | null>;

  /**
   * Active template block for a slug (optionally pinned to a version).
   * Used by the TPL-6.3 template-block check at install and rollout time.
   */
  findActiveTemplateBlock(
    orgId: string,
    slug: string,
    version?: string,
  ): Promise<ControlBlock | null>;
}
