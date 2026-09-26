import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { previousMonthWindow } from './billing-credits.service';
import { INVOICE_DRAFT_REPOSITORY } from './repositories/repository-tokens';
import type { IInvoiceDraftRepository } from './repositories/invoice-draft.repository';

/**
 * Automatic period invoicing (gap B-2): a month-end job that drafts the
 * invoice for EVERY ledger (org × product) that had spend in the closing
 * month — no manual console act required. The draft is a real document:
 * line items (kind × model) + pending adjustments + credit application,
 * oldest-grant-first. Idempotent per (org, product, period_start) — the
 * unique index makes a rerun a no-op.
 */
@Injectable()
export class BillingCycleService {
  private readonly logger = new Logger(BillingCycleService.name);

  constructor(
    @Inject(INVOICE_DRAFT_REPOSITORY) private readonly drafts: IInvoiceDraftRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Draft last month's invoices for every ledger with usage. Runs on the
   * billing namespace worker (monthly, 1st of the month 00:10 UTC) and can
   * be triggered manually for backfills.
   */
  async runForPreviousMonth(): Promise<{ drafted: number; skipped: number; total_usd: number }> {
    const { from, to } = previousMonthWindow(new Date());

    // Every (org, product) with usage in the window — the atomic draft
    // owns line items, adjustments, credit application, and the total.
    const ledgers = await this.drafts.discoverPeriodLedgers(from, to);

    let drafted = 0;
    let skipped = 0;
    let totalUsd = 0;
    for (const ledger of ledgers) {
      try {
        const invoice = await this.drafts.draftPeriodInvoice(ledger.orgId, ledger.product, from, to);
        if (invoice) {
          drafted += 1;
          totalUsd += Number(invoice.totalUsd);
        } else {
          skipped += 1;
        }
      } catch (err) {
        this.logger.error(`auto-draft failed for ${ledger.orgId}/${ledger.product}: ${(err as Error).message}`);
      }
    }
    await this.audit.add({
      action: 'billing.cycle_completed',
      resourceType: 'billing_cycle',
      actorType: 'system',
      details: { period_start: from, drafted, skipped, total_usd: totalUsd.toFixed(2) },
    });
    return { drafted, skipped, total_usd: Number(totalUsd.toFixed(2)) };
  }
}
