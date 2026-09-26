import { Inject, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../organizations/entitlements.service';
import { SPEND_EVENT_REPOSITORY } from './repositories/repository-tokens';
import type { ISpendEventRepository } from './repositories/spend-event.repository';

/**
 * Usage queries (B-2/B-3) with the partitioning rule enforced by structure:
 * per-product/project slices NEVER cross products — the consolidated
 * rollup is a separate, read-only view and the ONLY place totals cross
 * product boundaries (partitioning §3; a chat subscription never nets
 * against studio usage except in the rollup).
 *
 * All queries run inside the org's RLS context; time defaults to the last
 * 30 days. Money math: sums are computed in SQL numeric and transported as
 * strings; JS floats only format.
 */
export interface UsageWindow {
  from: string; // ISO
  to: string; // ISO
}

export interface ProjectSlice {
  project_id: string | null;
  cost_usd: string;
  events: number;
  tokens_in: number;
  tokens_out: number;
}

export interface ProductSlice {
  product: string;
  cost_usd: string;
  events: number;
  tokens_in: number;
  tokens_out: number;
  projects: ProjectSlice[];
}

export interface UsageOverview {
  window: UsageWindow;
  products: ProductSlice[];
}

export interface RollupView {
  window: UsageWindow;
  total_usd: string;
  products: Array<{ product: string; cost_usd: string; share: number }>;
}

export interface LedgerView {
  org_id: string;
  window: UsageWindow;
  ledgers: Array<{
    product: string;
    entitlement_status: string;
    plan: string;
    period_cost_usd: string;
    events: number;
    last_activity: string | null;
  }>;
}

const DAY_MS = 86_400_000;

@Injectable()
export class UsageQueryService {
  constructor(
    @Inject(SPEND_EVENT_REPOSITORY) private readonly spend: ISpendEventRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Per-product slices; optionally narrowed to one product (and project). */
  async overview(
    orgId: string,
    filter: { product?: string; projectId?: string; from?: string; to?: string } = {},
  ): Promise<UsageOverview> {
    const window = normalizeWindow(filter.from, filter.to);
    const { products, projects: projectRows } = await this.spend.overview(orgId, {
      product: filter.product,
      projectId: filter.projectId,
      from: window.from,
      to: window.to,
    });

    const perProduct = new Map(products.map((p) => [p.product, p]));
    // Projects for the queried products only (a project slice below a
    // product row stays within that product — no cross-product shape).
    const projectsByProduct = new Map<string, ProjectSlice[]>();
    for (const row of projectRows) {
      const list = projectsByProduct.get(row.product) ?? [];
      list.push({
        project_id: row.projectId,
        cost_usd: row.costUsd ?? '0',
        events: row.events,
        tokens_in: row.tokensIn,
        tokens_out: row.tokensOut,
      });
      projectsByProduct.set(row.product, list);
    }

    return {
      window,
      products: [...perProduct.values()]
        .map((p) => ({
          product: p.product,
          cost_usd: p.costUsd ?? '0',
          events: p.events,
          tokens_in: p.tokensIn,
          tokens_out: p.tokensOut,
          projects: (projectsByProduct.get(p.product) ?? []).sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd)),
        }))
        .sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd)),
    };
  }

  /** THE consolidated rollup — the only cross-product totals endpoint. */
  async rollup(orgId: string, filter: { from?: string; to?: string } = {}): Promise<RollupView> {
    const window = normalizeWindow(filter.from, filter.to);
    const rows = await this.spend.rollupByProduct(orgId, window);
    const total = rows.reduce((acc, row) => acc + Number(row.costUsd ?? 0), 0);
    return {
      window,
      total_usd: total.toFixed(6),
      products: rows
        .map((row) => ({
          product: row.product,
          cost_usd: row.costUsd ?? '0',
          share: total > 0 ? Number(row.costUsd ?? 0) / total : 0,
        }))
        .sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd)),
    };
  }

  /** Per-(org × product) ledgers with the entitlement-state join (M-3). */
  async ledgers(orgId: string, filter: { from?: string; to?: string } = {}): Promise<LedgerView> {
    const window = normalizeWindow(filter.from, filter.to);
    const [entitlementRows, usageRows] = await Promise.all([
      this.entitlements.listForOrg(orgId),
      this.spend.ledgerUsageByProduct(orgId, window),
    ]);

    const entitlementByProduct = new Map(entitlementRows.map((row) => [row.product, row]));
    const usageByProduct = new Map(usageRows.map((row) => [row.product, row]));
    const productKeys = new Set([...entitlementByProduct.keys(), ...usageByProduct.keys()]);

    const ledgers = [...productKeys].sort().map((product) => {
      const entitlement = entitlementByProduct.get(product);
      const usage = usageByProduct.get(product);
      return {
        product,
        entitlement_status: entitlement?.status ?? 'none',
        plan: entitlement?.plan ?? 'none',
        period_cost_usd: usage?.costUsd ?? '0',
        events: usage?.events ?? 0,
        last_activity: usage?.lastActivity ?? null,
      };
    });
    return { org_id: orgId, window, ledgers };
  }

  /**
   * Daily series for one (org, product) — chart backing for product usage
   * pages. Never crosses products (products render their own series).
   */
  async dailySeries(
    orgId: string,
    product: string,
    filter: { projectId?: string; from?: string; to?: string } = {},
  ): Promise<{ window: UsageWindow; days: Array<{ day: string; cost_usd: string; events: number }> }> {
    const window = normalizeWindow(filter.from, filter.to);
    const rows = await this.spend.dailySeries(orgId, product, {
      projectId: filter.projectId,
      from: window.from,
      to: window.to,
    });
    return {
      window,
      days: rows.map((r) => ({ day: r.day, cost_usd: r.costUsd ?? '0', events: r.events })),
    };
  }

  /** Conversations-style counter for product summary cards (kind-based). */
  async countByKind(orgId: string, product: string, kind: string, sinceIso: string): Promise<number> {
    return this.spend.countByKind(orgId, product, kind, sinceIso);
  }

  /** Simple period total (invoice draft computation). */
  async periodTotal(orgId: string, product: string, from: string, to: string): Promise<string> {
    return this.spend.periodTotal(orgId, product, from, to);
  }
}

function normalizeWindow(from?: string, to?: string): UsageWindow {
  const toMs = to && Number.isFinite(Date.parse(to)) ? Date.parse(to) : Date.now();
  const fromMs = from && Number.isFinite(Date.parse(from)) ? Date.parse(from) : toMs - 30 * DAY_MS;
  // Clamp: max 366 days per query (protects the aggregation path).
  const clampedFrom = Math.max(fromMs, toMs - 366 * DAY_MS);
  return { from: new Date(clampedFrom).toISOString(), to: new Date(toMs).toISOString() };
}
