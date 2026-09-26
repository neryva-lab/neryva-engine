/**
 * MongoDB lane for {@link IInvoiceRepository} (P3, B-2/M-3). Mirrors
 * `PgInvoiceRepository` method-for-method: list/get, the manual-draft
 * idempotency read (by period_start, any status), upsertDraft (insert, or
 * on the (org, product, period_start) conflict reset a VOIDED row back to
 * draft — the caller guarantees only a voided row can conflict), and
 * transitionInvoice to an already-validated target with the matching
 * timestamp stamp.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { InvoiceRow } from '../schema';
import {
  binUuid,
  isDuplicateKey,
  requireOrg,
  tenantCollection,
  toInvoice,
  type InvoiceMongoDoc,
} from './mongo-documents';
import type { IInvoiceRepository, InvoiceTransitionTarget } from './invoice.repository';

const COLLECTION = 'billing_invoices';

@Injectable()
export class MongoInvoiceRepository implements IInvoiceRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async listInvoices(orgId: string, product?: string): Promise<InvoiceRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<InvoiceMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const docs = await col
        .find(org, product ? { product } : {}, { session: ctx.session })
        .toArray();
      return docs.map(toInvoice);
    });
  }

  async getInvoice(orgId: string, invoiceId: string): Promise<InvoiceRow | null> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<InvoiceMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const doc = await col.findOne(org, { id: binUuid(invoiceId, 'invoiceId') }, { session: ctx.session });
      return doc ? toInvoice(doc) : null;
    });
  }

  async findDraftForPeriod(orgId: string, product: string, periodStartIso: string): Promise<InvoiceRow | null> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<InvoiceMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const doc = await col.findOne(
        org,
        { product, period_start: periodStartIso },
        { session: ctx.session },
      );
      return doc ? toInvoice(doc) : null;
    });
  }

  async upsertDraft(
    orgId: string,
    product: string,
    periodStartIso: string,
    periodEndIso: string,
    totalUsd: string,
  ): Promise<InvoiceRow> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<InvoiceMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const session = { session: ctx.session };
      const now = new Date().toISOString();
      const doc: InvoiceMongoDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(org),
        product,
        period_start: periodStartIso,
        period_end: periodEndIso,
        status: 'draft',
        total_usd: totalUsd,
        currency: 'USD',
        issued_at: null,
        paid_at: null,
        voided_at: null,
        created_at: now,
        updated_at: now,
      };
      try {
        await col.insertOne(org, doc, session);
        return toInvoice(doc);
      } catch (err) {
        if (!isDuplicateKey(err)) {
          throw err;
        }
      }
      // Only a voided row can reach the conflict — safe to reset to draft.
      const reset = await col.findOneAndUpdate(
        org,
        { product, period_start: periodStartIso },
        { $set: { status: 'draft', total_usd: totalUsd, voided_at: null, updated_at: now } },
        { ...session, returnDocument: 'after' },
      );
      if (!reset) {
        throw new Error('invoice upsert conflict on a row that vanished');
      }
      return toInvoice(reset);
    });
  }

  async transitionInvoice(
    orgId: string,
    invoiceId: string,
    target: InvoiceTransitionTarget,
  ): Promise<InvoiceRow | null> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<InvoiceMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const now = new Date().toISOString();
      const set: Record<string, string> = { status: target, updated_at: now };
      if (target === 'issued') {
        set.issued_at = now;
      } else if (target === 'paid') {
        set.paid_at = now;
      } else if (target === 'void') {
        set.voided_at = now;
      }
      const doc = await col.findOneAndUpdate(
        org,
        { id: binUuid(invoiceId, 'invoiceId') },
        { $set: set },
        { session: ctx.session, returnDocument: 'after' },
      );
      return doc ? toInvoice(doc) : null;
    });
  }
}
