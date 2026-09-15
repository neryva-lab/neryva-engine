import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { assertUuid } from './assert';

/**
 * FL-2.22/2.23/2.24 — read side of the analytics rollups computed by the
 * outbox consumer. All aggregation happens in the recompute path; this
 * service only reads the durable buckets (org-scoped, bounded).
 */
@Injectable()
export class AnalyticsQueryService {
  constructor(private readonly db: DbService) {}

  async rollups(orgId: string, kind?: string, days?: number, assistantId?: string): Promise<Array<Record<string, unknown>>> {
    assertUuid(orgId, 'orgId');
    if (assistantId !== undefined) {
      assertUuid(assistantId, 'assistantId');
    }
    const windowDays = Math.min(Math.max(1, days ?? 30), 365);
    const assistantFilter = assistantId === undefined ? sql`` : sql`and scope->>'assistant_id' = ${assistantId}`;
    return this.db.withOrg(orgId, async (tx) => {
      const rows = kind
        ? await tx.execute(sql`
            select kind, period_start, scope, metrics, computed_at
            from analytics_rollups
            where organization_id = ${orgId}::uuid and kind = ${kind}
              and period_start > current_date - ${windowDays}::int
              ${assistantFilter}
            order by period_start desc, kind
            limit 400
          `)
        : await tx.execute(sql`
            select kind, period_start, scope, metrics, computed_at
            from analytics_rollups
            where organization_id = ${orgId}::uuid
              and period_start > current_date - ${windowDays}::int
              ${assistantFilter}
            order by period_start desc, kind
            limit 400
          `);
      return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        kind: r.kind,
        period_start: r.period_start,
        scope: r.scope,
        metrics: r.metrics,
        computed_at: r.computed_at,
      }));
    });
  }
}
