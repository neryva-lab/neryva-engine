import { Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { NewSpendEvent, spendEvents } from '../schema';
import type {
  ISpendEventRepository,
  SpendOverviewFilter,
} from './spend-event.repository';
import type {
  DailyLedgerRow,
  NewSpendEventRow,
  ReconcileMonthRow,
  SpendDayRow,
  SpendLedgerUsageRow,
  SpendProjectSliceRow,
  SpendSliceRow,
  UsageExportRow,
} from './repository-types';

/**
 * PostgreSQL `ISpendEventRepository` (P3). Mechanical extraction of the
 * persistence logic from `SpendIngestService.ingest`,
 * `UsageQueryService`, `billing.worker.ts` (budget_eval), `QuotaService.reconcileMonth`,
 * `AnomalyService.scan`, and `BillingExtensionController.usageExport`.
 */
@Injectable()
export class PgSpendEventRepository implements ISpendEventRepository {
  constructor(private readonly db: DbService) {}

  async ingestBatch(orgId: string, rows: NewSpendEventRow[]): Promise<{ accepted: number; duplicates: number }> {
    if (rows.length === 0) {
      return { accepted: 0, duplicates: 0 };
    }
    const values: NewSpendEvent[] = rows.map((row) => ({
      id: uuidv7(),
      eventId: row.eventId,
      source: row.source,
      orgId: row.orgId,
      product: row.product,
      projectId: row.projectId,
      surface: row.surface,
      endUserId: row.endUserId,
      kind: row.kind,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: row.costUsd,
      meta: row.meta,
      occurredAt: row.occurredAt,
    }));
    const inserted = await this.db.withOrg(orgId, (tx) =>
      tx
        .insert(spendEvents)
        .values(values)
        .onConflictDoNothing({ target: [spendEvents.source, spendEvents.eventId] })
        .returning({ id: spendEvents.id }),
    );
    return { accepted: inserted.length, duplicates: rows.length - inserted.length };
  }

  async overview(orgId: string, filter: SpendOverviewFilter): Promise<{ products: SpendSliceRow[]; projects: SpendProjectSliceRow[] }> {
    const products = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          product: spendEvents.product,
          costUsd: sql<string>`sum(${spendEvents.costUsd})`,
          events: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(${spendEvents.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${spendEvents.tokensOut}), 0)::int`,
        })
        .from(spendEvents)
        .where(
          and(
            eq(spendEvents.orgId, orgId),
            gte(spendEvents.occurredAt, filter.from),
            lte(spendEvents.occurredAt, filter.to),
            filter.product ? eq(spendEvents.product, filter.product) : undefined,
            filter.projectId ? eq(spendEvents.projectId, filter.projectId) : undefined,
          ),
        )
        .groupBy(spendEvents.product),
    );
    const projectRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          product: spendEvents.product,
          projectId: spendEvents.projectId,
          costUsd: sql<string>`sum(${spendEvents.costUsd})`,
          events: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(${spendEvents.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${spendEvents.tokensOut}), 0)::int`,
        })
        .from(spendEvents)
        .where(
          and(
            eq(spendEvents.orgId, orgId),
            gte(spendEvents.occurredAt, filter.from),
            lte(spendEvents.occurredAt, filter.to),
            filter.product ? eq(spendEvents.product, filter.product) : undefined,
          ),
        )
        .groupBy(spendEvents.product, spendEvents.projectId),
    );
    const mappedProducts: SpendSliceRow[] = products
      .map((p) => ({
        product: p.product,
        costUsd: p.costUsd ?? '0',
        events: p.events,
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
      }))
      .sort((a, b) => Number(b.costUsd) - Number(a.costUsd));
    const mappedProjects: SpendProjectSliceRow[] = projectRows
      .map((row) => ({
        product: row.product,
        projectId: row.projectId,
        costUsd: row.costUsd ?? '0',
        events: row.events,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
      }))
      .sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : Number(b.costUsd) - Number(a.costUsd)));
    return { products: mappedProducts, projects: mappedProjects };
  }

  async rollupByProduct(orgId: string, window: { from: string; to: string }): Promise<SpendSliceRow[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          product: spendEvents.product,
          costUsd: sql<string>`sum(${spendEvents.costUsd})`,
          events: sql<number>`count(*)::int`,
          tokensIn: sql<number>`coalesce(sum(${spendEvents.tokensIn}), 0)::int`,
          tokensOut: sql<number>`coalesce(sum(${spendEvents.tokensOut}), 0)::int`,
        })
        .from(spendEvents)
        .where(and(eq(spendEvents.orgId, orgId), gte(spendEvents.occurredAt, window.from), lte(spendEvents.occurredAt, window.to)))
        .groupBy(spendEvents.product),
    );
    return rows.map((row) => ({
      product: row.product,
      costUsd: row.costUsd ?? '0',
      events: row.events,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
    }));
  }

  async ledgerUsageByProduct(orgId: string, window: { from: string; to: string }): Promise<SpendLedgerUsageRow[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          product: spendEvents.product,
          costUsd: sql<string>`sum(${spendEvents.costUsd})`,
          events: sql<number>`count(*)::int`,
          lastActivity: sql<string | null>`max(${spendEvents.occurredAt})`,
        })
        .from(spendEvents)
        .where(and(eq(spendEvents.orgId, orgId), gte(spendEvents.occurredAt, window.from), lte(spendEvents.occurredAt, window.to)))
        .groupBy(spendEvents.product),
    );
    return rows.map((row) => ({
      product: row.product,
      costUsd: row.costUsd,
      events: row.events,
      lastActivity: row.lastActivity,
    }));
  }

  async dailySeries(
    orgId: string,
    product: string,
    filter: { projectId?: string; from: string; to: string },
  ): Promise<SpendDayRow[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          day: sql<string>`to_char(date_trunc('day', ${spendEvents.occurredAt}), 'YYYY-MM-DD')`,
          costUsd: sql<string>`sum(${spendEvents.costUsd})`,
          events: sql<number>`count(*)::int`,
        })
        .from(spendEvents)
        .where(
          and(
            eq(spendEvents.orgId, orgId),
            eq(spendEvents.product, product),
            gte(spendEvents.occurredAt, filter.from),
            lte(spendEvents.occurredAt, filter.to),
            filter.projectId ? eq(spendEvents.projectId, filter.projectId) : undefined,
          ),
        )
        .groupBy(sql`date_trunc('day', ${spendEvents.occurredAt})`)
        .orderBy(sql`date_trunc('day', ${spendEvents.occurredAt})`),
    );
    return rows.map((r) => ({ day: r.day, costUsd: r.costUsd ?? '0', events: r.events }));
  }

  async countByKind(orgId: string, product: string, kind: string, sinceIso: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(spendEvents)
        .where(
          and(
            eq(spendEvents.orgId, orgId),
            eq(spendEvents.product, product),
            eq(spendEvents.kind, kind),
            gte(spendEvents.occurredAt, sinceIso),
          ),
        ),
    );
    return rows[0]?.count ?? 0;
  }

  async periodTotal(orgId: string, product: string, from: string, to: string): Promise<string> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ total: sql<string>`sum(${spendEvents.costUsd})` })
        .from(spendEvents)
        .where(and(eq(spendEvents.orgId, orgId), eq(spendEvents.product, product), gte(spendEvents.occurredAt, from), lte(spendEvents.occurredAt, to))),
    );
    return Number(rows[0]?.total ?? 0).toFixed(2);
  }

  async monthlySpend(orgId: string, product: string | null, monthStartIso: string): Promise<number> {
    const rows = await this.db.withBypass((tx) =>
      tx.execute<{ total: string }>(sql`
        select coalesce(sum(cost_usd), 0)::text as total from billing.spend_events
        where org_id = ${orgId} and occurred_at >= ${monthStartIso}::timestamptz
          ${product ? sql`and product = ${product}` : sql``}
      `),
    );
    return Number(rows.rows[0]?.total ?? 0);
  }

  async reconcileMonthRows(): Promise<ReconcileMonthRow[]> {
    const result = await this.db.withBypass((tx) =>
      tx.execute<{ org_id: string; product: string; project_id: string | null; usd: string; events: number }>(sql`
        select org_id, product, project_id,
               sum(cost_usd)::text as usd,
               count(*)::int as events
        from billing.spend_events
        where occurred_at >= date_trunc('month', now())
        group by 1, 2, 3
      `),
    );
    return result.rows.map((row) => ({
      orgId: row.org_id,
      product: row.product,
      projectId: row.project_id,
      usd: row.usd,
      events: row.events,
    }));
  }

  async dailyLedgerRows(): Promise<DailyLedgerRow[]> {
    const rows = await this.db.withBypass((tx) =>
      // Justification (withBypass): the scan walks every org's ledgers — an
      // explicitly administrative, cross-tenant read.
      tx.execute<{ org_id: string; product: string; day: string; cost_usd: string }>(sql`
        with daily as (
          select org_id, product,
                 to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day,
                 sum(cost_usd) as cost_usd
          from billing.spend_events
          where occurred_at >= now() - interval '30 days'
          group by 1, 2, 3
        )
        select org_id, product, day, cost_usd::text as cost_usd
        from (
          select org_id, product, day, cost_usd,
                 count(*) over (partition by org_id, product) as days_seen,
                 row_number() over (partition by org_id, product order by day desc) as recency
          from daily
        ) t
        where days_seen >= 8
        order by org_id, product, day asc
      `),
    );
    return rows.rows.map((row) => ({
      orgId: row.org_id,
      product: row.product,
      day: row.day,
      costUsd: row.cost_usd,
    }));
  }

  async exportUsage(
    orgId: string,
    filter: { from: string; to: string; product?: string },
  ): Promise<UsageExportRow[]> {
    const toMs = filter.to && Number.isFinite(Date.parse(filter.to)) ? Date.parse(filter.to) : Date.now();
    const fromMs = filter.from && Number.isFinite(Date.parse(filter.from)) ? Date.parse(filter.from) : toMs - 30 * 86_400_000;
    const cappedFrom = Math.max(fromMs, toMs - 366 * 86_400_000);
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute<{
        occurred_at: string;
        product: string;
        project_id: string | null;
        surface: string | null;
        end_user_id: string | null;
        kind: string;
        model: string | null;
        tokens_in: number | null;
        tokens_out: number | null;
        cost_usd: string;
      }>(sql`
        select occurred_at, product, project_id, surface, end_user_id, kind, model, tokens_in, tokens_out, cost_usd
        from billing.spend_events
        where org_id = ${orgId}
          and occurred_at >= ${new Date(cappedFrom).toISOString()}::timestamptz
          and occurred_at <= ${new Date(toMs).toISOString()}::timestamptz
          ${filter.product ? sql`and product = ${filter.product}` : sql``}
        order by occurred_at
        limit 10000
      `),
    );
    return rows.rows;
  }
}
