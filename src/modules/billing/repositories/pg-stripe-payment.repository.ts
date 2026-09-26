import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { InvoiceRow, billingInvoices } from '../schema';
import type { IStripePaymentRepository } from './stripe-payment.repository';

/**
 * PostgreSQL `IStripePaymentRepository` (P3, H-1). Mechanical extraction of
 * the settlement write from `StripeService.handleEvent`: the UPDATE only
 * matches a draft/issued row, so an already-paid invoice (Stripe's
 * retries) is a no-op returning null. `issued_at` is backfilled for
 * implicit issuance (`coalesce(issued_at, now)`).
 *
 * One bypass transaction (the settlement is provider-driven, not
 * request-scoped). Signature verification, event routing, audit, and the
 * `billing.invoice_paid` emission stay in the service.
 */
@Injectable()
export class PgStripePaymentRepository implements IStripePaymentRepository {
  constructor(private readonly db: DbService) {}

  async settleInvoiceAsPaid(invoiceId: string, nowIso: string): Promise<InvoiceRow | null> {
    const updated = await this.db.withBypass((tx) =>
      tx
        .update(billingInvoices)
        .set({
          status: 'paid',
          issuedAt: sql`coalesce(${billingInvoices.issuedAt}, ${nowIso}::timestamptz)`,
          paidAt: nowIso,
          updatedAt: nowIso,
        })
        .where(and(eq(billingInvoices.id, invoiceId), inArray(billingInvoices.status, ['draft', 'issued'])))
        .returning(),
    );
    return updated[0] ?? null;
  }
}
