import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { billingInvoiceLines } from '../billing-extension.schema';
import type { BillingInvoiceLineRow } from './repository-types';
import type { IInvoiceLineRepository } from './invoice-line.repository';

/**
 * PostgreSQL `IInvoiceLineRepository` (P3, B-5). Mechanical extraction of
 * the line-item read from `BillingExtensionController.invoiceLines`.
 *
 * Line rows carry no org column on the PostgreSQL lane; the tenant
 * boundary is the invoice itself, and this read runs in the org's RLS
 * context. The controller keeps its response mapping.
 */
@Injectable()
export class PgInvoiceLineRepository implements IInvoiceLineRepository {
  constructor(private readonly db: DbService) {}

  async listLinesByInvoice(orgId: string, invoiceId: string): Promise<BillingInvoiceLineRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(billingInvoiceLines).where(eq(billingInvoiceLines.invoiceId, invoiceId)),
    );
  }
}
