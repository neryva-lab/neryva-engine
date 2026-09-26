/**
 * MongoDB lane for {@link IStripePaymentRepository} (P3, H-1). Mirrors
 * `PgStripePaymentRepository`: the settlement UPDATE only matches a
 * draft/issued row, so an already-paid invoice (Stripe's retries) is a
 * no-op returning null. `issued_at` is backfilled for implicit issuance.
 * One bypass transaction (provider-driven, not request-scoped).
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { InvoiceRow } from '../schema';
import { binUuid, toInvoice, type InvoiceMongoDoc } from './mongo-documents';
import type { IStripePaymentRepository } from './stripe-payment.repository';

const COLLECTION = 'billing_invoices';

@Injectable()
export class MongoStripePaymentRepository implements IStripePaymentRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async settleInvoiceAsPaid(invoiceId: string, nowIso: string): Promise<InvoiceRow | null> {
    return this.mongo.withBypass(async (ctx) => {
      const col = this.mongo.root.collection<InvoiceMongoDoc>(COLLECTION);
      const existing = await col.findOne(
        { id: binUuid(invoiceId, 'invoiceId') },
        { session: ctx.session, projection: { id: 1, status: 1, issued_at: 1 } },
      );
      if (!existing || (existing.status !== 'draft' && existing.status !== 'issued')) {
        return null;
      }
      const doc = await col.findOneAndUpdate(
        { id: existing.id, status: { $in: ['draft', 'issued'] } },
        {
          $set: {
            status: 'paid',
            // coalesce(issued_at, now): backfill implicit issuance.
            issued_at: existing.issued_at ?? nowIso,
            paid_at: nowIso,
            updated_at: nowIso,
          },
        },
        { session: ctx.session, returnDocument: 'after' },
      );
      return doc ? toInvoice(doc) : null;
    });
  }
}
