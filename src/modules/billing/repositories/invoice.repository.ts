/**
 * `IInvoiceRepository` — the invoice-record aggregate (P3, B-2/M-3).
 *
 * Per (org × product) — independent partitions, never netted (ADR-001).
 * The status machine itself (draft → issued → paid, any → void) is validated
 * by the SERVICE against `INVOICE_TRANSITIONS`; this port owns only the
 * persistence units:
 *
 *  - `listInvoices` / `getInvoice` — one org-scoped read each.
 *  - `findDraftForPeriod` — the manual-draft idempotency read.
 *  - `upsertDraft` — one org transaction: insert, or on the
 *    (org, product, period_start) conflict reset a VOIDED row back to draft
 *    (only a voided row can reach the conflict — the caller checks first).
 *  - `transitionInvoice` — one org transaction: conditional status flip to
 *    an already-validated target, stamping issued_at / paid_at / voided_at.
 *    Returns null when the row is missing (the service maps to not_found).
 *
 * What stays OUT: state-machine validation, audit writes (replayed by the
 * service from inputs + results), and the draft total computation (the
 * service calls `UsageQueryService.periodTotal` between
 * `findDraftForPeriod` and `upsertDraft`).
 */
import type { InvoiceRow, InvoiceStatus } from '../schema';

export type InvoiceTransitionTarget = Exclude<InvoiceStatus, 'draft'>;

export interface IInvoiceRepository {
  listInvoices(orgId: string, product?: string): Promise<InvoiceRow[]>;

  getInvoice(orgId: string, invoiceId: string): Promise<InvoiceRow | null>;

  findDraftForPeriod(orgId: string, product: string, periodStartIso: string): Promise<InvoiceRow | null>;

  upsertDraft(
    orgId: string,
    product: string,
    periodStartIso: string,
    periodEndIso: string,
    totalUsd: string,
  ): Promise<InvoiceRow>;

  /**
   * Flip to an already-validated target, stamping the matching timestamp
   * (issued → issued_at, paid → paid_at, void → voided_at) plus updated_at.
   * Returns null when the invoice does not exist.
   */
  transitionInvoice(orgId: string, invoiceId: string, target: InvoiceTransitionTarget): Promise<InvoiceRow | null>;
}
