/**
 * Org-info repository (P3) — the persistence port for the Python-owned
 * `tenants` seam (org brief / name for email + notification context) plus
 * the settings service's region/retention reads and tenant-profile update.
 *
 * Each method owns its unit of work: no transaction handle or callback
 * leaks through this interface — callers get plain domain results.
 *
 * Tenant discipline: `tenants` is deliberately unscoped — every access is
 * by explicit id (or an explicit id list), never a table scan. The
 * PostgreSQL implementation reads through `DbService.root` (no RLS
 * context); the MongoDB implementation uses a `PlatformCollection` with a
 * justifying comment, mirroring the pg lane's `db.root`/`withBypass`
 * escape hatches.
 *
 * The interface carries no drizzle or mongodb runtime dependency.
 *
 * What stays OUT of the repository (still the callers' job):
 * - input validation (region/retention bounds live in the settings service)
 * - audit diffing and audit writes (`org.settings_updated`)
 * - event emission and notification emails
 */
export interface OrgBrief {
  id: string;
  name: string;
  slug: string;
  createdAt: string | null;
  /** features.deleted=true after the purge pass marks the row deleted. */
  markedDeleted: boolean;
}

export interface IOrgInfoRepository {
  /** Org profile row for email/notification context; null when missing. */
  getBrief(orgId: string): Promise<OrgBrief | null>;

  /** Org display name; falls back to 'your organization' when missing. */
  getName(orgId: string): Promise<string>;

  /**
   * Briefs for exactly the given org ids (the org-picker payload source) —
   * never an unbounded table scan.
   */
  listBriefs(orgIds: string[]): Promise<OrgBrief[]>;

  /** The Python-owned data-residency/retention columns; null when missing. */
  getTenantFields(orgId: string): Promise<{ region: string | null; retentionDays: number | null } | null>;

  /**
   * Patch the Python-owned tenant profile; sets `updated_at` = now.
   * Only the keys the caller supplies move. The pg lane maps
   * `retentionDays` to the `retention_days` column (the old service's
   * camelCase key never matched and was silently dropped).
   */
  updateTenantProfile(orgId: string, patch: { name?: string; region?: string; retentionDays?: number }): Promise<void>;
}
