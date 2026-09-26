/**
 * `IStripePaymentRepository` — the Stripe settlement write (P3, H-1).
 *
 * Settlement is idempotent: the UPDATE only matches a draft/issued row, so
 * an already-paid invoice (Stripe's retries) is a no-op returning null.
 * `issued_at` is backfilled for implicit issuance
 * (`coalesce(issued_at, now)`).
 *
 * One bypass transaction (the settlement is provider-driven, not
 * request-scoped). What stays OUT: signature verification (pure, in the
 * service), the event-type routing, audit writes, and the
 * `billing.invoice_paid` emission (the service replays from the result).
 */
import type { InvoiceRow } from '../schema';

export interface IStripePaymentRepository {
  /**
   * Mark the invoice paid iff it is currently draft/issued. Returns the
   * updated row, or null when the invoice is missing or already
   * paid/void (a non-transition — the caller treats both as handled:false).
   */
  settleInvoiceAsPaid(invoiceId: string, nowIso: string): Promise<InvoiceRow | null>;
}
