import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';

/**
 * Org-scoped audit reads (eng-0009). audit_events is the shared Tier-0
 * hash-chain table (Python-owned DDL, no RLS) — every query here filters by
 * tenant_id explicitly and never writes: the appender in the kernel is the
 * sole write path, append-only by construction.
 *
 * The query surface is the benchmark set: actor/action/resource filters,
 * time window, pagination with a total, and a bounded CSV/JSON export for
 * SIEM ingestion (Vercel-enterprise pattern) — capped so an export can
 * never become a table scan DoS on the shared chain.
 */
export interface AuditQueryFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  from?: string; // ISO timestamp
  to?: string; // ISO timestamp
  limit?: number;
  offset?: number;
}

export const AUDIT_QUERY_MAX_LIMIT = 200;
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

interface AuditRow {
  [column: string]: unknown;
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: unknown;
  created_at: string;
}

@Injectable()
export class OrgAuditService {
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

  private validateTime(f: AuditQueryFilters): void {
    for (const [key, value] of [['from', f.from], ['to', f.to]] as const) {
      if (value !== undefined && value !== '' && !Number.isFinite(Date.parse(value))) {
        throw ApiError.validation({ [key]: 'must be an ISO timestamp' });
      }
    }
  }

  async query(orgId: string, filters: AuditQueryFilters): Promise<{ events: AuditRow[]; total: number }> {
    this.validateTime(filters);
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), AUDIT_QUERY_MAX_LIMIT);
    const offset = Math.max(filters.offset ?? 0, 0);
    const where = this.buildWhere(orgId, filters);

    const rows = await this.db.root.execute<AuditRow>(sql`
      select id, actor_type, actor_id, action, resource_type, resource_id, details, created_at
      from audit_events
      where ${where}
      order by created_at desc, id desc
      limit ${limit} offset ${offset}
    `);
    const totals = await this.db.root.execute<{ total: string }>(sql`
      select count(*) as total from audit_events where ${where}
    `);
    return { events: rows.rows, total: Number(totals.rows[0]?.total ?? 0) };
  }

  /**
   * Bounded export for SIEM ingestion. CSV columns are stable-ordered;
   * details JSON is embedded (RFC 4180-quoted). The cap is honest: an export
   * beyond AUDIT_EXPORT_MAX_ROWS must narrow its window — chain reads stay
   * cheap for everyone.
   */
  async export(orgId: string, filters: AuditQueryFilters, format: 'csv' | 'json'): Promise<{ body: string; contentType: string; filename: string }> {
    const rows = await this.db.root.execute<AuditRow>(sql`
      select id, actor_type, actor_id, action, resource_type, resource_id, details, created_at
      from audit_events
      where ${this.buildWhere(orgId, filters)}
      order by created_at asc, id asc
      limit ${AUDIT_EXPORT_MAX_ROWS + 1}
    `);
    const events = rows.rows.slice(0, AUDIT_EXPORT_MAX_ROWS);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      return {
        body: JSON.stringify({ org_id: orgId, exported_at: new Date().toISOString(), count: events.length, truncated: rows.rows.length > AUDIT_EXPORT_MAX_ROWS, events }, null, 2),
        contentType: 'application/json',
        filename: `neryva-audit-${orgId}-${timestamp}.json`,
      };
    }

    const header = 'id,created_at,actor_type,actor_id,action,resource_type,resource_id,details';
    const lines = events.map((row) =>
      [row.id, row.created_at, row.actor_type, row.actor_id ?? '', row.action, row.resource_type, row.resource_id ?? '', JSON.stringify(row.details ?? {})]
        .map(csvEscape)
        .join(','),
    );
    return {
      body: [header, ...lines].join('\r\n'),
      contentType: 'text/csv; charset=utf-8',
      filename: `neryva-audit-${orgId}-${timestamp}.csv`,
    };
  }

  /** Distinct values for the filter dropdowns (bounded, cached by the caller's HTTP layer). Actions ordered by frequency so the most useful chips surface first. */
  async filterFacets(orgId: string): Promise<{ actions: string[]; resourceTypes: string[] }> {
    const actions = await this.db.root.execute<{ action: string }>(sql`
      select action from audit_events where tenant_id = ${orgId} group by action order by count(*) desc limit 500
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

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
