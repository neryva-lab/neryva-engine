import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { billingInvoices, INVOICE_TRANSITIONS, InvoiceRow, InvoiceStatus } from './schema';
import { UsageQueryService } from './usage-query.service';

/**
 * Invoice records (B-2/M-3): per (org × product) — independent partitions,
 * never netted (ADR-001). Payment-provider integration is out of scope;
 * this is the ledger record with a small explicit status machine:
 *
 *   draft → issued → paid
 *      ↘ void ↙      ↘ void
 *
 * Every transition is validated against INVOICE_TRANSITIONS and audited as
 * `billing.invoice_transitioned`. Draft totals are computed from the spend
 * events of the period at creation time (a snapshot, not a live view).
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly manifests: ManifestRegistryService,
    private readonly usage: UsageQueryService,
  ) {}

  async list(orgId: string, product?: string): Promise<InvoiceRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(billingInvoices)
        .where(product ? and(eq(billingInvoices.orgId, orgId), eq(billingInvoices.product, product)) : eq(billingInvoices.orgId, orgId)),
    );
  }

  async get(orgId: string, invoiceId: string): Promise<InvoiceRow> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(billingInvoices)
        .where(and(eq(billingInvoices.id, invoiceId), eq(billingInvoices.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('invoice');
    }
    return rows[0];
  }

  /**
   * Create (or re-create after void) the draft invoice for one period of one
   * product ledger. Idempotent: an existing non-void invoice for the same
   * (org, product, period_start) is returned as-is.
   */
  async createDraft(input: {
    orgId: string;
    product: string;
    periodStart: string;
    periodEnd: string;
    actorId: string;
  }): Promise<InvoiceRow> {
    this.manifests.require(input.product);

    const start = new Date(input.periodStart);
    const end = new Date(input.periodEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw ApiError.validation({ period: 'period_start must precede period_end (ISO-8601)' });
    }

    const existing = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select()
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.orgId, input.orgId),
            eq(billingInvoices.product, input.product),
            eq(billingInvoices.periodStart, start.toISOString()),
          ),
        )
        .limit(1),
    );
    if (existing[0] && existing[0].status !== 'void') {
      return existing[0];
    }

    const total = await this.usage.periodTotal(input.orgId, input.product, start.toISOString(), end.toISOString());
    const upsert = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingInvoices)
        .values({
          orgId: input.orgId,
          product: input.product,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          status: 'draft',
          totalUsd: total,
        })
        .onConflictDoUpdate({
          target: [billingInvoices.orgId, billingInvoices.product, billingInvoices.periodStart],
          // Only a voided row can reach the conflict — safe to reset to draft.
          set: { status: 'draft', totalUsd: total, voidedAt: null, updatedAt: new Date().toISOString() },
        })
        .returning(),
    );
    const invoice = upsert[0];
    await this.audit.add({
      action: 'billing.invoice_drafted',
      resourceType: 'billing_invoice',
      resourceId: invoice.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: input.product,
      details: { total_usd: total, period_start: start.toISOString(), period_end: end.toISOString() },
    });
    return invoice;
  }

  async transition(input: {
    orgId: string;
    invoiceId: string;
    target: Exclude<InvoiceStatus, 'draft'>;
    actorId: string;
  }): Promise<InvoiceRow> {
    const invoice = await this.get(input.orgId, input.invoiceId);
    if (invoice.status === input.target) {
      return invoice; // idempotent no-op
    }
    const allowed = INVOICE_TRANSITIONS[invoice.status as keyof typeof INVOICE_TRANSITIONS];
    if (!allowed || !allowed.includes(input.target)) {
      throw ApiError.conflict(`invalid invoice transition ${invoice.status} -> ${input.target}`);
    }
    const now = new Date().toISOString();
    const patch: Partial<typeof billingInvoices.$inferInsert> = { status: input.target, updatedAt: now };
    if (input.target === 'issued') {
      patch.issuedAt = now;
    } else if (input.target === 'paid') {
      patch.paidAt = now;
    } else if (input.target === 'void') {
      patch.voidedAt = now;
    }

    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(billingInvoices)
        .set(patch)
        .where(and(eq(billingInvoices.id, input.invoiceId), eq(billingInvoices.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('invoice');
    }
    await this.audit.add({
      action: 'billing.invoice_transitioned',
      resourceType: 'billing_invoice',
      resourceId: input.invoiceId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: invoice.product,
      details: { from: invoice.status, to: input.target, total_usd: invoice.totalUsd },
    });
    return updated[0];
  }
}
