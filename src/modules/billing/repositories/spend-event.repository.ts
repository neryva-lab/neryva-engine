/**
 * `ISpendEventRepository` — the `billing.spend_events` aggregate (P3).
 *
 * One repository for the engine's metering plane: satellite/ingest writes
 * plus every read-only aggregation over the same table (usage views,
 * rollups, ledger usage, daily series, budget/quota/anomaly/export reads).
 * Money math: sums are computed in SQL numeric and transported as strings;
 * JS floats only format.
 *
 * Transaction boundaries (each method owns its unit — no handles leak):
 *  - `ingestBatch` — one org-scoped transaction; `onConflictDoNothing` on
 *    the (source, event_id) unique index makes satellite retries
 *    non-double-billing.
 *  - Every read — one org-scoped transaction (or bypass for the explicitly
 *    cross-tenant admin passes: `reconcileMonthRows`, `dailyLedgerRows`).
 *
 * What stays OUT: input validation (callers pre-validate), the
 * platform-authoritative cost derivation (price catalog), audit writes
 * (replayed by the service from inputs + results), and metrics emission
 * (the service owns `meteringIngestRows`).
 */
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

export interface SpendOverviewFilter {
  product?: string;
  projectId?: string;
  from: string;
  to: string;
}

export interface ISpendEventRepository {
  /**
   * Insert a batch for one org. Idempotent by (source, event_id): a
   * satellite retrying a push never double-bills. Returns the accepted /
   * duplicate counts (duplicates = rows swallowed by the unique index).
   * The caller de-duplicates within the batch itself before calling.
   */
  ingestBatch(orgId: string, rows: NewSpendEventRow[]): Promise<{ accepted: number; duplicates: number }>;

  /**
   * Per-product slices plus the per-(product × project) breakdown for the
   * same window (the usage-overview backing query). The project slice is
   * grouped under its product — no cross-product shape.
   */
  overview(
    orgId: string,
    filter: SpendOverviewFilter,
  ): Promise<{ products: SpendSliceRow[]; projects: SpendProjectSliceRow[] }>;

  /** Per-product cost totals — the consolidated-rollup backing query. */
  rollupByProduct(orgId: string, window: { from: string; to: string }): Promise<SpendSliceRow[]>;

  /** Per-product usage for the ledger view (the entitlement join stays in the service). */
  ledgerUsageByProduct(orgId: string, window: { from: string; to: string }): Promise<SpendLedgerUsageRow[]>;

  /** Daily (org × product) cost series for product usage pages. Never crosses products. */
  dailySeries(
    orgId: string,
    product: string,
    filter: { projectId?: string; from: string; to: string },
  ): Promise<SpendDayRow[]>;

  /** Kind-based event counter for product summary cards. */
  countByKind(orgId: string, product: string, kind: string, sinceIso: string): Promise<number>;

  /** Simple period total (the manual invoice-draft computation). Formatted to 2dp. */
  periodTotal(orgId: string, product: string, from: string, to: string): Promise<string>;

  /**
   * Month-to-date spend for one (org × product-or-all) — the budget-worker
   * `spendLookup`. Cross-tenant by design (the worker evaluates every org's
   * budgets): runs in the bypass context.
   */
  monthlySpend(orgId: string, product: string | null, monthStartIso: string): Promise<number>;

  /**
   * Current-month per-(org × product × project) spend + event counts — the
   * quota-reconciliation resync read. Cross-tenant by design: bypass context.
   */
  reconcileMonthRows(): Promise<ReconcileMonthRow[]>;

  /**
   * Trailing-30-day per-(org × product × day) spend — the cost-anomaly scan
   * read. Cross-tenant by design: bypass context.
   */
  dailyLedgerRows(): Promise<DailyLedgerRow[]>;

  /**
   * The usage export (B-6): capped, ordered NDJSON rows for one org with an
   * optional product filter. The caller serializes to NDJSON and sets the
   * download headers.
   */
  exportUsage(
    orgId: string,
    filter: { from: string; to: string; product?: string },
  ): Promise<UsageExportRow[]>;
}
