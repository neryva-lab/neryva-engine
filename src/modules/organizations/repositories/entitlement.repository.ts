/**
 * Entitlement repository (P3) — the persistence port for the platform-owned
 * product-entitlement ledger (`EntitlementsService` state-machine reads and
 * the read-then-upsert `transition` write).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly as
 * the first parameter (or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `org_id` predicate on every collection access
 * (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - transition validation (the TRANSITIONS table, seat bounds)
 * - trial-stage gating (ManifestRegistryService) and trial defaults
 * - audit writes (`entitlement.transitioned`, replayed by the service)
 * - event emission (`EntitlementTransitioned`)
 * - effective-limits overlays (trial/past_due/suspended/expired policy)
 */
import type { EntitlementState } from '../../../common/auth/ports';
import type { productEntitlements } from '../schema';

export type EntitlementRow = typeof productEntitlements.$inferSelect;

export interface IEntitlementRepository {
  /** Raw row read; the service maps a miss to the virtual `none` state. */
  getEntitlement(orgId: string, product: string): Promise<EntitlementRow | null>;

  /** All entitlement rows for the org. */
  listEntitlements(orgId: string): Promise<EntitlementRow[]>;

  /**
   * The write half of the service's read-then-upsert `transition`: insert
   * when no row exists for (org, product), otherwise update only the fields
   * the caller supplied (plus `updatedAt`). The two-step shape is preserved
   * — the service performs the read via `getEntitlement` first; this method
   * must NOT merge the read into a single upsert. Returns the post-write row.
   */
  upsertEntitlement(input: {
    orgId: string;
    product: string;
    target: Exclude<EntitlementState, 'none'>;
    plan?: string;
    limits?: Record<string, unknown>;
    seats?: number | null;
    period?: { start: string; end: string };
    source?: string;
  }): Promise<EntitlementRow>;
}
