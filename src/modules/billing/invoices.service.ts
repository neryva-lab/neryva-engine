import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { INVOICE_TRANSITIONS, InvoiceRow, InvoiceStatus } from './schema';
import { UsageQueryService } from './usage-query.service';
import { INVOICE_REPOSITORY } from './repositories/repository-tokens';
import type { IInvoiceRepository } from './repositories/invoice.repository';

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
    @Inject(INVOICE_REPOSITORY) private readonly invoices: IInvoiceRepository,
    private readonly audit: AuditService,
    private readonly manifests: ManifestRegistryService,
    private readonly usage: UsageQueryService,
  ) {}

  async list(orgId: string, product?: string): Promise<InvoiceRow[]> {
    return this.invoices.listInvoices(orgId, product);
  }

  async get(orgId: string, invoiceId: string): Promise<InvoiceRow> {
    const row = await this.invoices.getInvoice(orgId, invoiceId);
    if (!row) {
      throw ApiError.notFound('invoice');
    }
    return row;
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

    const existing = await this.invoices.findDraftForPeriod(input.orgId, input.product, start.toISOString());
    if (existing && existing.status !== 'void') {
      return existing;
    }

    const total = await this.usage.periodTotal(input.orgId, input.product, start.toISOString(), end.toISOString());
    const invoice = await this.invoices.upsertDraft(input.orgId, input.product, start.toISOString(), end.toISOString(), total);
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

    const updated = await this.invoices.transitionInvoice(input.orgId, input.invoiceId, input.target);
    if (!updated) {
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
    return updated;
  }
}
