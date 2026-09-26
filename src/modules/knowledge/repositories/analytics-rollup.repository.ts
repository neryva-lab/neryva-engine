/**
 * Analytics-rollup repository (P3) — the persistence port for the read side
 * of the analytics rollups (`AnalyticsQueryService`, FL-2.22/2.23/2.24).
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* — the interface carries no drizzle
 * runtime dependency. (Rollup computation is a writer outside this port;
 * this port is the typed read side.)
 */
import type { RollupRow } from './repository-types';

export interface IAnalyticsRollupRepository {
  /**
   * Rollup rows for the org: optional `kind` filter
   * (`csat_daily | conversation_outcomes_daily | usage_daily`), last
   * `windowDays` days, optional `assistantId` scope, capped at `limit`.
   * Newest period first.
   */
  rollups(
    orgId: string,
    opts: { kind?: string; windowDays: number; assistantId?: string; limit: number },
  ): Promise<RollupRow[]>;
}
