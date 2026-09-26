import { eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { legacyTenants } from '../../../common/infra/db/legacy-schema';
import type { IOrgInfoRepository, OrgBrief } from './org-info.repository';

/**
 * PostgreSQL implementation of `IOrgInfoRepository` (P3).
 *
 * Mechanical move of the `org-info.ts` reads plus the settings service's
 * `tenants` region/retention reads and `legacyTenants` profile updates —
 * all via `DbService.root` (no RLS context), justified as the Python-owned
 * seam: `tenants` is Python-owned DDL and reads/writes here are always by
 * explicit id, never unbounded.
 *
 * What stays OUT (still the callers' job): region/retention validation
 * bounds, audit diffing and audit writes, event emission.
 */
export class PgOrgInfoRepository implements IOrgInfoRepository {
  constructor(private readonly db: DbService) {}

  async getBrief(orgId: string): Promise<OrgBrief | null> {
    const rows = await this.db.root.execute<{
      id: string;
      name: string;
      slug: string;
      created_at: string | null;
      deleted: boolean;
    }>(sql`
      select id, name, slug, created_at,
             coalesce(features->>'deleted', 'false')::boolean as deleted
      from tenants
      where id = ${orgId}
      limit 1
    `);
    const row = rows.rows[0];
    if (!row) {
      return null;
    }
    return { id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at, markedDeleted: row.deleted };
  }

  async getName(orgId: string): Promise<string> {
    const brief = await this.getBrief(orgId);
    return brief?.name ?? 'your organization';
  }

  async listBriefs(orgIds: string[]): Promise<OrgBrief[]> {
    if (orgIds.length === 0) {
      return [];
    }
    // Justification (root): cross-org read for exactly the caller's
    // memberships; ids come from the filtered membership query upstream —
    // the service's old withBypass listContexts read, narrowed to briefs.
    const rows = await this.db.root
      .select({
        id: legacyTenants.id,
        name: legacyTenants.name,
        slug: legacyTenants.slug,
        createdAt: legacyTenants.created_at,
        features: legacyTenants.features,
      })
      .from(legacyTenants)
      .where(inArray(legacyTenants.id, orgIds));
    return rows.map((row) => {
      const deleted = (row.features as { deleted?: unknown } | null)?.deleted;
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        createdAt: row.createdAt,
        // Coalesce like getBrief's `coalesce(features->>'deleted','false')::boolean`.
        markedDeleted: deleted === true || deleted === 'true',
      };
    });
  }

  async getTenantFields(orgId: string): Promise<{ region: string | null; retentionDays: number | null } | null> {
    const rows = await this.db.root
      .select({ region: legacyTenants.region, retentionDays: legacyTenants.retention_days })
      .from(legacyTenants)
      .where(eq(legacyTenants.id, orgId))
      .limit(1);
    const row = rows[0];
    return row ? { region: row.region, retentionDays: row.retentionDays } : null;
  }

  async updateTenantProfile(orgId: string, patch: { name?: string; region?: string; retentionDays?: number }): Promise<void> {
    const set: Partial<typeof legacyTenants.$inferInsert> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) {
      set.name = patch.name;
    }
    if (patch.region !== undefined) {
      set.region = patch.region;
    }
    // FOUND BUG (fixed here): the old service built `tenantUpdate` with the
    // camelCase key `retentionDays` — no such property exists on the
    // `legacyTenants` table (the column is `retention_days`), so the
    // retention update was silently dropped on every write. The property key
    // MUST be `retention_days`.
    if (patch.retentionDays !== undefined) {
      set.retention_days = patch.retentionDays;
    }
    await this.db.root.update(legacyTenants).set(set).where(eq(legacyTenants.id, orgId));
  }
}
