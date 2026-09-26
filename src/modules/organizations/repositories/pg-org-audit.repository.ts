import { sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import type {
  AuditEventRow,
  AuditQueryFilters,
  IOrgAuditRepository,
} from './org-audit.repository';

/**
 * PostgreSQL implementation of `IOrgAuditRepository` (P3).
 *
 * `audit_events` is the shared Tier-0 hash-chain table (Python-owned DDL,
 * no RLS) — every query here filters `tenant_id` explicitly and never
 * writes, so reads go through `DbService.root` rather than a tenant-scoped
 * transaction. The appender in the kernel is the sole write path,
 * append-only by construction.
 *
 * What stays OUT (still the caller's job): input validation
 * (ISO-timestamp checks), limit/offset clamps, CSV/JSON shaping.
 */
export class PgOrgAuditRepository implements IOrgAuditRepository {
  constructor(private readonly db: DbService) {}

  private buildWhere(orgId: string, f: AuditQueryFilters) {
    const conditions = [sql`tenant_id = ${orgId}`];
    if (f.actorId) {
      conditions.push(sql`actor_id = ${f.actorId}`);
    }
    if (f.action) {
      // Exact action or an action prefix filter ("org." → every org.* event).
      conditions.push(sql`action = ${f.action}`);
    }
    if (f.resourceType) {
      conditions.push(sql`resource_type = ${f.resourceType}`);
    }
    if (f.from) {
      conditions.push(sql`created_at >= ${f.from}::timestamptz`);
    }
    if (f.to) {
      conditions.push(sql`created_at <= ${f.to}::timestamptz`);
    }
    return sql.join(conditions, sql` and `);
  }

  /**
   * Filtered, paginated events for the org plus the total matching count
   * (two queries, one predicate). Sort is (created_at, id) in the
   * requested direction.
   */
  async query(orgId: string, filters: AuditQueryFilters): Promise<{ events: AuditEventRow[]; total: number }> {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const where = this.buildWhere(orgId, filters);
    const order = filters.order === 'asc' ? sql`created_at asc, id asc` : sql`created_at desc, id desc`;

    const rows = await this.db.root.execute<AuditEventRow>(sql`
      select id, actor_type, actor_id, action, resource_type, resource_id, details, created_at
      from audit_events
      where ${where}
      order by ${order}
      limit ${limit} offset ${offset}
    `);
    const totals = await this.db.root.execute<{ total: string }>(sql`
      select count(*) as total from audit_events where ${where}
    `);
    return { events: rows.rows, total: Number(totals.rows[0]?.total ?? 0) };
  }

  /**
   * Distinct values for the filter dropdowns, bounded: actions ordered by
   * frequency (most useful chips first), resource types alphabetical.
   */
  async filterFacets(orgId: string): Promise<{ actions: string[]; resourceTypes: string[] }> {
    const actions = await this.db.root.execute<{ action: string }>(sql`
      select action from audit_events where tenant_id = ${orgId} group by action order by count(*) desc, action asc limit 500
    `);
    const resourceTypes = await this.db.root.execute<{ resource_type: string }>(sql`
      select distinct resource_type from audit_events where tenant_id = ${orgId} order by resource_type limit 200
    `);
    return {
      actions: actions.rows.map((r) => r.action),
      resourceTypes: resourceTypes.rows.map((r) => r.resource_type),
    };
  }
}
