import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { InvoiceRow, billingInvoices } from '../schema';
import type {
  IInvoiceRepository,
  InvoiceTransitionTarget,
} from './invoice.repository';

/**
 * PostgreSQL `IInvoiceRepository` (P3, B-2/M-3). Mechanical extraction of
 * the persistence units from `InvoicesService` (`list`, `get`,
 * `createDraft`'s existence check + `onConflictDoUpdate`, `transition`'s
 * conditional update).
 *
 * State-machine validation, audit, and the draft total computation stay in
 * the service: `getInvoice` returns null instead of throwing, and
 * `transitionInvoice` flips to an already-validated target.
 */
@Injectable()
export class PgInvoiceRepository implements IInvoiceRepository {
  constructor(private readonly db: DbService) {}

  async listInvoices(orgId: string, product?: string): Promise<InvoiceRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(billingInvoices)
        .where(product ? and(eq(billingInvoices.orgId, orgId), eq(billingInvoices.product, product)) : eq(billingInvoices.orgId, orgId)),
    );
  }

  async getInvoice(orgId: string, invoiceId: string): Promise<InvoiceRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(billingInvoices)
        .where(and(eq(billingInvoices.id, invoiceId), eq(billingInvoices.orgId, orgId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async findDraftForPeriod(orgId: string, product: string, periodStartIso: string): Promise<InvoiceRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.orgId, orgId),
            eq(billingInvoices.product, product),
            eq(billingInvoices.periodStart, periodStartIso),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async upsertDraft(
    orgId: string,
    product: string,
    periodStartIso: string,
    periodEndIso: string,
    totalUsd: string,
  ): Promise<InvoiceRow> {
    const upsert = await this.db.withOrg(orgId, (tx) =>
      tx
        .insert(billingInvoices)
        .values({
          orgId,
          product,
          periodStart: periodStartIso,
          periodEnd: periodEndIso,
          status: 'draft',
          totalUsd,
        })
        .onConflictDoUpdate({
          target: [billingInvoices.orgId, billingInvoices.product, billingInvoices.periodStart],
          // Only a voided row can reach the conflict — safe to reset to draft.
          set: { status: 'draft', totalUsd, voidedAt: null, updatedAt: new Date().toISOString() },
        })
        .returning(),
    );
    return upsert[0];
  }

  async transitionInvoice(orgId: string, invoiceId: string, target: InvoiceTransitionTarget): Promise<InvoiceRow | null> {
    const now = new Date().toISOString();
    const patch: Partial<typeof billingInvoices.$inferInsert> = { status: target, updatedAt: now };
    if (target === 'issued') {
      patch.issuedAt = now;
    } else if (target === 'paid') {
      patch.paidAt = now;
    } else if (target === 'void') {
      patch.voidedAt = now;
    }
    const updated = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(billingInvoices)
        .set(patch)
        .where(and(eq(billingInvoices.id, invoiceId), eq(billingInvoices.orgId, orgId)))
        .returning(),
    );
    return updated[0] ?? null;
  }
}
