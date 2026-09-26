/**
 * `IInvoiceDraftRepository` — the automatic period-invoice drafting unit
 * (P3, gap B-2).
 *
 * This port exists to resolve the pre-P3 transaction-handle leak:
 * `BillingCycleService.draftOne` used to own a Drizzle transaction and
 * pass it into `BillingCreditsService.buildLineItems` /
 * `buildUsageLedgerLineItems` / `applyAdjustments` / `applyToInvoice`.
 * The new contract forbids leaking transaction handles, so the ENTIRE
 * draft — idempotency check, invoice row, spend lines, usage-ledger
 * lines, adjustments, credit application, total — is one repository-owned
 * transaction here. The line-building/credit-application logic moved
 * with it, mechanically preserved.
 *
 *  - `discoverPeriodLedgers` — the cycle discovery read (bypass): every
 *    (org × product) with spend in the half-open window, from satellite
 *    spend rows plus engine run-usage ledger rows (the ledger leg
 *    attributes to the `agents` product). Half-open on both legs: an event
 *    exactly at the month boundary belongs to exactly one draft.
 *  - `draftPeriodInvoice` — one org transaction:
 *      1. idempotency: an existing non-void invoice for
 *         (org, product, period_start) → return null (rerun is a no-op);
 *      2. insert the draft invoice row (total 0);
 *      3. spend line items (kind × model) from `billing.spend_events`;
 *      4. usage-ledger line items (usage_kind × provider × model) — only
 *         for the `agents` product;
 *      5. pending adjustments for (org, product);
 *      6. credit application, oldest-expiring-first;
 *      7. total = max(0, gross + ledgerGross + adjustments - creditApplied).
 *
 * What stays OUT: the per-ledger error isolation (the service catches per
 * ledger so one bad draft never blocks the cycle), the cycle audit write,
 * and the previous-month window computation (pure, stays in the service).
 */
export interface PeriodLedgerRow {
  orgId: string;
  product: string;
  costUsd: string;
}

export interface DraftInvoiceResult {
  invoiceId: string;
  totalUsd: string;
}

export interface IInvoiceDraftRepository {
  discoverPeriodLedgers(fromIso: string, toIso: string): Promise<PeriodLedgerRow[]>;

  /**
   * Draft one ledger's invoice atomically. Returns null when an existing
   * non-void invoice already covers the period (idempotent rerun).
   */
  draftPeriodInvoice(orgId: string, product: string, fromIso: string, toIso: string): Promise<DraftInvoiceResult | null>;
}
