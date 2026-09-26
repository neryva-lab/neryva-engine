/**
 * MongoDB lane for {@link ISpendEventRepository} (P3). Mirrors
 * `PgSpendEventRepository` method-for-method: idempotent ingest by the
 * (source, event_id) unique index (11000 → duplicate, exactly like
 * `onConflictDoNothing`), the usage-overview/rollup/ledger-usage/daily
 * aggregations with pg-identical sort orders, the trailing-30-day
 * anomaly scan (only org×product pairs with ≥ 8 days seen), and the
 * capped usage export window (max 366 days, inclusive upper bound,
 * limit 10000).
 *
 * `cost_usd` travels as a numeric string; aggregations use `$toDouble`
 * and format with `toFixed(6)`, replicating pg's
 * `sum(numeric(12,6))::text` rendering. Day buckets use the ISO date
 * prefix (`$substr` of the ISO timestamp), equivalent to pg's
 * `to_char(date_trunc('day', …), 'YYYY-MM-DD')` for UTC timestamptz.
 */
import { Injectable } from '@nestjs/common';
import type { Binary } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  binUuid,
  ensureBillingIndexes,
  isDuplicateKey,
  requireOrg,
  tenantCollection,
  toFixed6,
  uuidOf,
  type SpendEventMongoDoc,
} from './mongo-documents';
import type { ISpendEventRepository, SpendOverviewFilter } from './spend-event.repository';
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

const COLLECTION = 'spend_events';

function periodMatch(from: string, to: string): Record<string, unknown> {
  return { occurred_at: { $gte: from, $lt: to } };
}

@Injectable()
export class MongoSpendEventRepository implements ISpendEventRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async ingestBatch(orgId: string, rows: NewSpendEventRow[]): Promise<{ accepted: number; duplicates: number }> {
    if (rows.length === 0) {
      return { accepted: 0, duplicates: 0 };
    }
    // Defensive: the (source, event_id) unique index backs the
    // onConflictDoNothing-equivalent duplicate detection below.
    await ensureBillingIndexes(this.mongo.root);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const session = { session: ctx.session };
      const now = new Date().toISOString();
      let accepted = 0;
      for (const row of rows) {
        const doc: SpendEventMongoDoc = {
          id: binUuid(uuidv7()),
          event_id: row.eventId,
          source: row.source,
          org_id: binUuid(row.orgId),
          product: row.product,
          project_id: row.projectId ? binUuid(row.projectId, 'projectId') : null,
          surface: row.surface,
          end_user_id: row.endUserId,
          kind: row.kind,
          model: row.model,
          tokens_in: row.tokensIn,
          tokens_out: row.tokensOut,
          cost_usd: row.costUsd,
          meta: row.meta,
          occurred_at: row.occurredAt,
          ingested_at: now,
        };
        try {
          await col.insertOne(org, doc, session);
          accepted += 1;
        } catch (err) {
          if (!isDuplicateKey(err)) {
            throw err;
          }
        }
      }
      return { accepted, duplicates: rows.length - accepted };
    });
  }

  async overview(
    orgId: string,
    filter: SpendOverviewFilter,
  ): Promise<{ products: SpendSliceRow[]; projects: SpendProjectSliceRow[] }> {
    const products = await this.productSlices(orgId, filter);
    const projects = await this.projectSlices(orgId, filter);
    return { products, projects };
  }

  private async productSlices(orgId: string, filter: SpendOverviewFilter): Promise<SpendSliceRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const match: Record<string, unknown> = {
        ...periodMatch(filter.from, filter.to),
        ...(filter.product ? { product: filter.product } : {}),
        ...(filter.projectId ? { project_id: binUuid(filter.projectId, 'projectId') } : {}),
      };
      const rows = (await col
        .aggregate(
          org,
          [
            { $match: match },
            {
              $group: {
                _id: '$product',
                cost_usd: { $sum: { $toDouble: '$cost_usd' } },
                events: { $sum: 1 },
                tokens_in: { $sum: { $ifNull: ['$tokens_in', 0] } },
                tokens_out: { $sum: { $ifNull: ['$tokens_out', 0] } },
              },
            },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as ({ _id: string; cost_usd: number; events: number; tokens_in: number; tokens_out: number })[];
      return rows
        .map((r) => ({
          product: r._id,
          costUsd: toFixed6(r.cost_usd),
          events: r.events,
          tokensIn: r.tokens_in,
          tokensOut: r.tokens_out,
        }))
        .sort((a, b) => Number(b.costUsd) - Number(a.costUsd));
    });
  }

  private async projectSlices(orgId: string, filter: SpendOverviewFilter): Promise<SpendProjectSliceRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const match: Record<string, unknown> = {
        ...periodMatch(filter.from, filter.to),
        ...(filter.product ? { product: filter.product } : {}),
      };
      const rows = (await col
        .aggregate(
          org,
          [
            { $match: match },
            {
              $group: {
                _id: { product: '$product', project_id: '$project_id' },
                cost_usd: { $sum: { $toDouble: '$cost_usd' } },
                events: { $sum: 1 },
                tokens_in: { $sum: { $ifNull: ['$tokens_in', 0] } },
                tokens_out: { $sum: { $ifNull: ['$tokens_out', 0] } },
              },
            },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as ({ _id: { product: string; project_id: Binary | null }; cost_usd: number; events: number; tokens_in: number; tokens_out: number })[];
      return rows
        .map((r) => ({
          product: r._id.product,
          projectId: r._id.project_id ? uuidOf(r._id.project_id) : null,
          costUsd: toFixed6(r.cost_usd),
          events: r.events,
          tokensIn: r.tokens_in,
          tokensOut: r.tokens_out,
        }))
        .sort((a, b) =>
          a.product < b.product ? -1 : a.product > b.product ? 1 : Number(b.costUsd) - Number(a.costUsd),
        );
    });
  }

  async rollupByProduct(orgId: string, window: { from: string; to: string }): Promise<SpendSliceRow[]> {
    return this.productSlices(orgId, { from: window.from, to: window.to });
  }

  async ledgerUsageByProduct(orgId: string, window: { from: string; to: string }): Promise<SpendLedgerUsageRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const rows = (await col
        .aggregate(
          org,
          [
            { $match: periodMatch(window.from, window.to) },
            {
              $group: {
                _id: '$product',
                cost_usd: { $sum: { $toDouble: '$cost_usd' } },
                events: { $sum: 1 },
                last_activity: { $max: '$occurred_at' },
              },
            },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as ({ _id: string; cost_usd: number; events: number; last_activity: string | null })[];
      return rows.map((r) => ({
        product: r._id,
        costUsd: toFixed6(r.cost_usd),
        events: r.events,
        lastActivity: r.last_activity,
      }));
    });
  }

  async dailySeries(
    orgId: string,
    product: string,
    filter: { projectId?: string; from: string; to: string },
  ): Promise<SpendDayRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const rows = (await col
        .aggregate(
          org,
          [
            {
              $match: {
                ...periodMatch(filter.from, filter.to),
                product,
                ...(filter.projectId ? { project_id: binUuid(filter.projectId, 'projectId') } : {}),
              },
            },
            {
              $group: {
                _id: { $substr: ['$occurred_at', 0, 10] },
                cost_usd: { $sum: { $toDouble: '$cost_usd' } },
                events: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as ({ _id: string; cost_usd: number; events: number })[];
      return rows.map((r) => ({ day: r._id, costUsd: toFixed6(r.cost_usd), events: r.events }));
    });
  }

  async countByKind(orgId: string, product: string, kind: string, sinceIso: string): Promise<number> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      return col.countDocuments(
        org,
        { product, kind, occurred_at: { $gte: sinceIso } },
        { session: ctx.session },
      );
    });
  }

  async periodTotal(orgId: string, product: string, from: string, to: string): Promise<string> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const rows = (await col
        .aggregate(
          org,
          [
            { $match: { ...periodMatch(from, to), product } },
            { $group: { _id: null, total: { $sum: { $toDouble: '$cost_usd' } } } },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as ({ _id: null; total: number })[];
      return (rows[0]?.total ?? 0).toFixed(2);
    });
  }

  async monthlySpend(orgId: string, product: string | null, monthStartIso: string): Promise<number> {
    return this.mongo.withBypass(async (ctx) => {
      const rows = await this.mongo.root
        .collection<SpendEventMongoDoc>(COLLECTION)
        .aggregate<{ _id: null; total: number }>(
          [
            {
              $match: {
                org_id: binUuid(orgId, 'orgId'),
                occurred_at: { $gte: monthStartIso },
                ...(product ? { product } : {}),
              },
            },
            { $group: { _id: null, total: { $sum: { $toDouble: '$cost_usd' } } } },
          ],
          { session: ctx.session },
        )
        .toArray();
      return rows[0]?.total ?? 0;
    });
  }

  async reconcileMonthRows(): Promise<ReconcileMonthRow[]> {
    return this.mongo.withBypass(async (ctx) => {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const rows = await this.mongo.root
        .collection<SpendEventMongoDoc>(COLLECTION)
        .aggregate<{
          _id: { org_id: SpendEventMongoDoc['org_id']; product: string; project_id: SpendEventMongoDoc['project_id'] };
          usd: number;
          events: number;
        }>(
          [
            { $match: { occurred_at: { $gte: monthStart.toISOString() } } },
            {
              $group: {
                _id: { org_id: '$org_id', product: '$product', project_id: '$project_id' },
                usd: { $sum: { $toDouble: '$cost_usd' } },
                events: { $sum: 1 },
              },
            },
          ],
          { session: ctx.session },
        )
        .toArray();
      return rows.map((r) => ({
        orgId: uuidOf(r._id.org_id),
        product: r._id.product,
        projectId: r._id.project_id ? uuidOf(r._id.project_id) : null,
        usd: toFixed6(r.usd),
        events: r.events,
      }));
    });
  }

  async dailyLedgerRows(): Promise<DailyLedgerRow[]> {
    return this.mongo.withBypass(async (ctx) => {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const rows = await this.mongo.root
        .collection<SpendEventMongoDoc>(COLLECTION)
        .aggregate<{
          _id: { org_id: SpendEventMongoDoc['org_id']; product: string; day: string };
          cost_usd: number;
          days_seen: number;
        }>(
          [
            { $match: { occurred_at: { $gte: cutoff } } },
            {
              $group: {
                _id: {
                  org_id: '$org_id',
                  product: '$product',
                  day: { $substr: ['$occurred_at', 0, 10] },
                },
                cost_usd: { $sum: { $toDouble: '$cost_usd' } },
              },
            },
            {
              $group: {
                _id: { org_id: '$_id.org_id', product: '$_id.product' },
                days: { $push: { day: '$_id.day', cost_usd: '$cost_usd' } },
                days_seen: { $sum: 1 },
              },
            },
            { $match: { days_seen: { $gte: 8 } } },
            { $unwind: '$days' },
            {
              $project: {
                _id: { org_id: '$_id.org_id', product: '$_id.product', day: '$days.day' },
                cost_usd: '$days.cost_usd',
              },
            },
            { $sort: { '_id.org_id': 1, '_id.product': 1, '_id.day': 1 } },
          ],
          { session: ctx.session },
        )
        .toArray();
      return rows.map((r) => ({
        orgId: uuidOf(r._id.org_id),
        product: r._id.product,
        day: r._id.day,
        costUsd: toFixed6(r.cost_usd),
      }));
    });
  }

  async exportUsage(
    orgId: string,
    filter: { from: string; to: string; product?: string },
  ): Promise<UsageExportRow[]> {
    // The export window is capped exactly like the pg lane: default 30d,
    // absolute cap 366d, inclusive upper bound, limit 10000, ordered.
    const toMs = filter.to && Number.isFinite(Date.parse(filter.to)) ? Date.parse(filter.to) : Date.now();
    const fromMs = filter.from && Number.isFinite(Date.parse(filter.from)) ? Date.parse(filter.from) : toMs - 30 * 86_400_000;
    const cappedFrom = Math.max(fromMs, toMs - 366 * 86_400_000);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<SpendEventMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const docs = await col
        .find(
          org,
          {
            occurred_at: { $gte: new Date(cappedFrom).toISOString(), $lte: new Date(toMs).toISOString() },
            ...(filter.product ? { product: filter.product } : {}),
          },
          { session: ctx.session, sort: { occurred_at: 1 }, limit: 10000 },
        )
        .toArray();
      return docs.map((d) => ({
        occurred_at: d.occurred_at,
        product: d.product,
        project_id: d.project_id ? uuidOf(d.project_id) : null,
        surface: d.surface,
        end_user_id: d.end_user_id,
        kind: d.kind,
        model: d.model,
        tokens_in: d.tokens_in,
        tokens_out: d.tokens_out,
        cost_usd: d.cost_usd,
      }));
    });
  }
}
