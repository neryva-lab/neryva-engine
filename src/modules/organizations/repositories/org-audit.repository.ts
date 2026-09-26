/**
 * Org-audit repository (P3) — the persistence port for org-scoped reads
 * over the shared Tier-0 `audit_events` hash-chain table
 * (`OrgAuditService.query` / `export` / `filterFacets`).
 *
 * `audit_events` is Python-owned DDL with no RLS — every query here filters
 * `tenant_id` explicitly and never writes: the appender in the kernel is
 * the sole write path, append-only by construction. The PostgreSQL
 * implementation therefore reads through `DbService.root`; the MongoDB
 * implementation uses a `PlatformCollection` with an explicit `tenant_id`
 * predicate and a justifying comment, mirroring the pg justification.
 *
 * Each method owns its unit of work; no transaction handle or callback
 * leaks through this interface — callers get plain domain results.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (ISO-timestamp checks)
 * - limit/offset clamps (`AUDIT_QUERY_MAX_LIMIT`, `AUDIT_EXPORT_MAX_ROWS`)
 * - CSV/JSON shaping for the SIEM export
 */
export interface AuditQueryFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  from?: string; // ISO timestamp
  to?: string; // ISO timestamp
  /** Already clamped by the service (`AUDIT_QUERY_MAX_LIMIT`). */
  limit?: number;
  /** Already clamped by the service (>= 0). */
  offset?: number;
  /**
   * Sort direction for (created_at, id). The query path uses 'desc'
   * (newest first); the service's export path passes 'asc' (oldest first)
   * so the truncation window matches the pg `order by created_at asc`
   * shape exactly.
   */
  order?: 'asc' | 'desc';
}

/** Raw audit row, snake_case like the service's select (never serialized raw). */
export interface AuditEventRow {
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

export interface IOrgAuditRepository {
  /**
   * Filtered, paginated events for the org plus the total matching count
   * (two queries, one predicate). Sort is (created_at, id) in the
   * requested direction.
   */
  query(orgId: string, filters: AuditQueryFilters): Promise<{ events: AuditEventRow[]; total: number }>;

  /**
   * Distinct values for the filter dropdowns, bounded: actions ordered by
   * frequency (most useful chips first), resource types alphabetical.
   */
  filterFacets(orgId: string): Promise<{ actions: string[]; resourceTypes: string[] }>;
}
