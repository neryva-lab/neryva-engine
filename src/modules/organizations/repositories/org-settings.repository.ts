/**
 * Org-settings repository (P3) — the persistence port for the ENGINE-OWNED
 * `org_settings` row only (`OrgSettingsService.ensureRow`/presentation
 * updates). The Python-owned `tenants` seam (profile reads,
 * region/retention reads, `updateTenantProfile`) is NOT here — it goes
 * through `IOrgInfoRepository`, injected in the service.
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
 * - input validation (email/branding/preferences rules)
 * - the default-project active check (ProjectsService)
 * - tenants-seam reads/writes (IOrgInfoRepository)
 * - from→to audit diffing and audit writes (`org.settings_updated`)
 * - event emission (`OrgSettingsUpdated`)
 */
import type { orgSettings } from '../schema';

export type OrgSettingsRow = typeof orgSettings.$inferSelect;

export interface IOrgSettingsRepository {
  /**
   * Settings row read, creating the lazy default on first touch:
   * insert-if-absent, then read (pg `onConflictDoNothing`; mongo
   * `updateOne` with `$setOnInsert` + upsert, then read). An existing row
   * is returned untouched (`updatedAt` does NOT move).
   */
  ensureRow(orgId: string): Promise<OrgSettingsRow>;

  /**
   * Upsert presentation state — only the keys the caller supplies move
   * (plus `updatedAt`, always). Branding/preferences arrive pre-merged by
   * the service; the repository sets them whole.
   */
  updateSettings(
    orgId: string,
    update: {
      supportEmail?: string | null;
      defaultProjectId?: string | null;
      branding?: Record<string, unknown>;
      preferences?: Record<string, unknown>;
      updatedAt: string;
    },
  ): Promise<void>;
}
