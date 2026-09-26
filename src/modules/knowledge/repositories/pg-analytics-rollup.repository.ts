import { sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import type { IAnalyticsRollupRepository } from './analytics-rollup.repository';
import type { RollupRow } from './repository-types';

/**
 * PostgreSQL implementation of `IAnalyticsRollupRepository` (P3).
 *
 * Mechanical move of the `AnalyticsQueryService.rollups` read: one
 * `DbService.withOrg` transaction, byte-identical SQL (kind filter,
 * window predicate, optional assistant scope, newest-first, capped).
 * UUID validation and window clamping stay in the service — the repository
 * binds exactly what it is given.
 */
export class PgAnalyticsRollupRepository implements IAnalyticsRollupRepository {
  constructor(private readonly db: DbService) {}

  async rollups(
    orgId: string,
    opts: { kind?: string; windowDays: number; assistantId?: string; limit: number },
  ): Promise<RollupRow[]> {
    const assistantFilter =
      opts.assistantId === undefined
        ? sql``
        : sql`and scope->>'assistant_id' = ${opts.assistantId}`;
    return this.db.withOrg(orgId, async (tx) => {
      const rows = opts.kind
        ? await tx.execute(sql`
            select id, kind, period_start, scope, metrics, computed_at
            from analytics_rollups
            where organization_id = ${orgId}::uuid and kind = ${opts.kind}
              and period_start > current_date - ${opts.windowDays}::int
              ${assistantFilter}
            order by period_start desc, kind
            limit ${opts.limit}
          `)
        : await tx.execute(sql`
            select id, kind, period_start, scope, metrics, computed_at
            from analytics_rollups
            where organization_id = ${orgId}::uuid
              and period_start > current_date - ${opts.windowDays}::int
              ${assistantFilter}
            order by period_start desc, kind
            limit ${opts.limit}
          `);
      return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        period_start: String(r.period_start),
        scope: r.scope,
        metrics: r.metrics,
        computed_at: String(r.computed_at),
      }));
    });
  }
}
