/**
 * Shared row/input types for the billing repository ports (P3).
 *
 * Row aliases are the drizzle `$inferSelect` shapes so both lanes return
 * identical application-level types. The pure invoice-derivation helpers
 * (`toLedgerLineKind`, `toLedgerLineNote`) moved here from
 * `billing-credits.service.ts`: both lanes' draft repositories need them,
 * and they must be byte-identical — one definition, no drift.
 */
import type {
  billingAdjustments,
  billingBudgets,
  billingCreditApplications,
  billingCredits,
  billingInvoiceLines,
} from '../billing-extension.schema';
import type { providerReconciliationRuns } from '../usage-ledger.schema';

export type BillingCreditRow = typeof billingCredits.$inferSelect;
export type BillingCreditApplicationRow = typeof billingCreditApplications.$inferSelect;
export type BillingBudgetRow = typeof billingBudgets.$inferSelect;
export type BillingInvoiceLineRow = typeof billingInvoiceLines.$inferSelect;
export type BillingAdjustmentRow = typeof billingAdjustments.$inferSelect;
export type ProviderReconciliationRunRow = typeof providerReconciliationRuns.$inferSelect;

// ── spend_events read shapes ──────────────────────────────────────────────

export interface SpendSliceRow {
  product: string;
  costUsd: string | null;
  events: number;
  tokensIn: number;
  tokensOut: number;
}

export interface SpendProjectSliceRow extends SpendSliceRow {
  projectId: string | null;
}

export interface SpendLedgerUsageRow {
  product: string;
  costUsd: string | null;
  events: number;
  lastActivity: string | null;
}

export interface SpendDayRow {
  day: string;
  costUsd: string | null;
  events: number;
}

export interface ReconcileMonthRow {
  orgId: string;
  product: string;
  projectId: string | null;
  usd: string;
  events: number;
}

export interface DailyLedgerRow {
  orgId: string;
  product: string;
  day: string;
  costUsd: string;
}

/** One spend event row as accepted by `ISpendEventRepository.ingestBatch`. */
export interface NewSpendEventRow {
  eventId: string;
  source: string;
  orgId: string;
  product: string;
  projectId: string | null;
  surface: string | null;
  endUserId: string | null;
  kind: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Formatted USD string (numeric columns travel as strings through JS). */
  costUsd: string;
  meta: Record<string, unknown>;
  occurredAt: string;
}

/** One usage-export (NDJSON) row — the exact column shape the export emits. */
export interface UsageExportRow {
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
}

// ── pure invoice-derivation helpers (REL-9 F1) ─────────────────────────────

/**
 * Ledger-derived line kind, namespaced so it can never collide with a
 * satellite spend kind on the same invoice. Sliced to the
 * `billing_invoice_lines.kind` varchar(32) bound.
 */
export function toLedgerLineKind(usageKind: string): string {
  const kind = usageKind && usageKind.trim().length > 0 ? usageKind.trim() : 'unknown';
  return `usage:${kind}`.slice(0, 32);
}

/**
 * Line provenance note: the ledger has no product column, so the provider
 * rides the free-text note (varchar(128)) for chargeback explainability.
 */
export function toLedgerLineNote(provider: string | null): string {
  return (provider && provider.trim().length > 0 ? `usage-ledger ${provider.trim()}` : 'usage-ledger').slice(0, 128);
}
