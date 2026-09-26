/**
 * `IInvoiceLineRepository` — the invoice line-item read port (P3, B-5).
 *
 * Line items are written only at draft time (inside
 * `IInvoiceDraftRepository.draftPeriodInvoice` — immutable once drafted; a
 * redraft deletes + regenerates). This port exposes the read the console
 * needs: one org-scoped query.
 *
 * Tenancy note: line rows carry no org column (PostgreSQL side); the
 * tenant boundary is the invoice itself. The MongoDB lane enforces it by
 * resolving the invoice under the tenant guard first — a line is returned
 * only when its invoice belongs to the requesting org.
 */
import type { BillingInvoiceLineRow } from './repository-types';

export interface IInvoiceLineRepository {
  listLinesByInvoice(orgId: string, invoiceId: string): Promise<BillingInvoiceLineRow[]>;
}
