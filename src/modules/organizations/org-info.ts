import { sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';

/**
 * Shared read helpers against the Python-owned `tenants` row (explicit
 * filtered cross-system reads per partitioning §5 — the engine never joins
 * its own FKs into that DDL, it reads by id). Used by the org services for
 * email/notification context so none of them duplicates the query.
 */
export interface OrgBrief {
  id: string;
  name: string;
  slug: string;
  createdAt: string | null;
  /** features.deleted=true after the purge pass marks the row deleted. */
  markedDeleted: boolean;
}

export async function getOrgBrief(db: DbService, orgId: string): Promise<OrgBrief | null> {
  const rows = await db.root.execute<{ id: string; name: string; slug: string; created_at: string; deleted: boolean }>(sql`
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

export async function getOrgName(db: DbService, orgId: string): Promise<string> {
  const brief = await getOrgBrief(db, orgId);
  return brief?.name ?? 'your organization';
}
