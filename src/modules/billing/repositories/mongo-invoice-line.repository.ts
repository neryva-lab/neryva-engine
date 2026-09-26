/**
 * MongoDB lane for {@link IInvoiceLineRepository} (P3, B-5). The line
 * read the console needs: resolve the invoice under the tenant guard
 * first (line rows carry no org column — the invoice is the tenant
 * boundary), then return its lines.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  binUuid,
  requireOrg,
  tenantCollection,
  toInvoiceLine,
  type BillingInvoiceLineMongoDoc,
  type InvoiceMongoDoc,
} from './mongo-documents';
import type { BillingInvoiceLineRow } from './repository-types';
import type { IInvoiceLineRepository } from './invoice-line.repository';

const LINES = 'billing_invoice_lines';
const INVOICES = 'billing_invoices';

@Injectable()
export class MongoInvoiceLineRepository implements IInvoiceLineRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async listLinesByInvoice(orgId: string, invoiceId: string): Promise<BillingInvoiceLineRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const session = { session: ctx.session };
      const invoices = tenantCollection<InvoiceMongoDoc>(this.mongo.root, INVOICES, 'org_id');
      const invoice = await invoices.findOne(org, { id: binUuid(invoiceId, 'invoiceId') }, session);
      if (!invoice) {
        return [];
      }
      const lines = tenantCollection<BillingInvoiceLineMongoDoc>(this.mongo.root, LINES, 'org_id');
      const docs = await lines.find(org, { invoice_id: invoice.id }, session).toArray();
      return docs.map(toInvoiceLine);
    });
  }
}
