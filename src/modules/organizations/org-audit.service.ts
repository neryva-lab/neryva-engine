import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { ORG_AUDIT_REPOSITORY } from './repositories/repository-tokens';
import type { AuditEventRow, IOrgAuditRepository } from './repositories/org-audit.repository';

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
  constructor(@Inject(ORG_AUDIT_REPOSITORY) private readonly auditRepository: IOrgAuditRepository) {}

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
    // Newest-first is the repository default; limit/offset are clamped here
    // (the repository clamps defensively too).
    const { events, total } = await this.auditRepository.query(orgId, { ...filters, limit, offset });
    return { events: events.map(toAuditRow), total };
  }

  /**
   * Bounded export for SIEM ingestion. CSV columns are stable-ordered;
   * details JSON is embedded (RFC 4180-quoted). The cap is honest: an export
   * beyond AUDIT_EXPORT_MAX_ROWS must narrow its window — chain reads stay
   * cheap for everyone.
   */
  async export(orgId: string, filters: AuditQueryFilters, format: 'csv' | 'json'): Promise<{ body: string; contentType: string; filename: string }> {
    // Oldest-first (truncation drops the newest) — the repository's
    // internal order override; the public filter surface is unchanged.
    const { events } = await this.auditRepository.query(orgId, {
      ...filters,
      order: 'asc',
      limit: AUDIT_EXPORT_MAX_ROWS + 1,
      offset: 0,
    });
    const rows = events.slice(0, AUDIT_EXPORT_MAX_ROWS);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      return {
        body: JSON.stringify({ org_id: orgId, exported_at: new Date().toISOString(), count: rows.length, truncated: events.length > AUDIT_EXPORT_MAX_ROWS, events: rows.map(toAuditRow) }, null, 2),
        contentType: 'application/json',
        filename: `neryva-audit-${orgId}-${timestamp}.json`,
      };
    }

    const header = 'id,created_at,actor_type,actor_id,action,resource_type,resource_id,details';
    const lines = rows.map((row) =>
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
    return this.auditRepository.filterFacets(orgId);
  }
}

function toAuditRow(row: AuditEventRow): AuditRow {
  return {
    id: row.id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    details: row.details,
    created_at: row.created_at,
  };
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
