import { sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { BillingCreditsService } from './billing-credits.service';
import { billingInvoices } from './schema';
import { legacyTenants } from '../../common/infra/db/legacy-schema';

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
    private readonly db: DbService,
    private readonly credits: BillingCreditsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Draft last month's invoices for every ledger with usage. Runs on the
   * billing namespace worker (monthly, 1st of the month 00:10 UTC) and can
   * be triggered manually for backfills.
   */
  async runForPreviousMonth(): Promise<{ drafted: number; skipped: number; total_usd: number }> {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = periodStart.toISOString();
    const to = periodEnd.toISOString();

    // Every (org, product) with spend in the window — engine-owned ledger rows only.
    const ledgers = await this.db.withBypass((tx) =>
      tx.execute<{ org_id: string; product: string; cost_usd: string }>(sql`
        select org_id, product, coalesce(sum(cost_usd), 0)::text as cost_usd
        from billing.spend_events
        where occurred_at >= ${from}::timestamptz and occurred_at < ${to}::timestamptz
        group by org_id, product
        having coalesce(sum(cost_usd), 0) > 0
      `),
    );
    void legacyTenants;

    let drafted = 0;
    let skipped = 0;
    let totalUsd = 0;
    for (const ledger of ledgers.rows) {
      try {
        const invoice = await this.draftOne({ orgId: ledger.org_id, product: ledger.product, from, to });
        if (invoice) {
          drafted += 1;
          totalUsd += Number(invoice.totalUsd);
        } else {
          skipped += 1;
        }
      } catch (err) {
        this.logger.error(`auto-draft failed for ${ledger.org_id}/${ledger.product}: ${(err as Error).message}`);
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

  /** Draft one ledger's invoice: line items → adjustments → credits → total. */
  private async draftOne(input: { orgId: string; product: string; from: string; to: string }): Promise<{ id: string; totalUsd: string } | null> {
    return this.db.withOrg(input.orgId, async (tx) => {
      // Idempotency: an existing non-void invoice for the period returns null.
      const existing = await tx
        .select({ id: billingInvoices.id })
        .from(billingInvoices)
        .where(sql`${billingInvoices.orgId} = ${input.orgId} and ${billingInvoices.product} = ${input.product} and ${billingInvoices.periodStart} = ${input.from} and ${billingInvoices.status} <> 'void'`)
        .limit(1);
      if (existing[0]) {
        return null;
      }
      const inserted = await tx
        .insert(billingInvoices)
        .values({
          orgId: input.orgId,
          product: input.product,
          periodStart: input.from,
          periodEnd: input.to,
          status: 'draft',
          totalUsd: '0',
        })
        .returning({ id: billingInvoices.id });
      const invoiceId = inserted[0].id;

      const gross = await this.credits.buildLineItems(tx, input.orgId, input.product, input.from, input.to, invoiceId);
      const adjustments = await this.credits.applyAdjustments(tx, input.orgId, input.product, invoiceId);
      const dueBeforeCredit = Math.max(0, gross + adjustments);
      const creditApplied = await this.credits.applyToInvoice(tx, input.orgId, invoiceId, dueBeforeCredit);
      const total = Math.max(0, dueBeforeCredit - creditApplied);
      await tx.update(billingInvoices).set({ totalUsd: total.toFixed(2) }).where(sql`${billingInvoices.id} = ${invoiceId}`);
      return { id: invoiceId, totalUsd: total.toFixed(2) };
    });
  }
}
