import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { NotificationsService } from '../notifications/notifications.service';
import { billingBudgets, billingCredits, billingCreditApplications, billingAdjustments, billingInvoiceLines } from './billing-extension.schema';
import { billingInvoices } from './schema';

/**
 * The credits + budgets + line-items engine (gaps B-2/B-3/B-5/B-7):
 *
 *  - Credits: grants with expiry applied at invoice-draft time
 *    OLDEST-EXPIRING-FIRST; a void returns applied credit (money is
 *    reversible). The parallel-session invoice flow calls
 *    `applyToInvoice` inside its draft transaction boundary.
 *  - Budgets: user-configured monthly USD caps with percent thresholds;
 *    the evaluation is called by the billing worker hourly — alerts land
 *    in the notification center (money roles) exactly once per threshold
 *    per cycle.
 *  - Line items + adjustments: the draft-time breakdown (kind × model)
 *    and signed corrections, so an invoice is a real document, not a
 *    single number.
 */
@Injectable()
export class BillingCreditsService {
  private readonly logger = new Logger(BillingCreditsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ── Credits ──────────────────────────────────────────────────────────────

  async grantCredit(input: { orgId: string; kind?: string; amountUsd: number; note?: string; expiresAt?: string | null; grantedBy: string }): Promise<Record<string, unknown>> {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0 || input.amountUsd > 1_000_000) {
      throw ApiError.validation({ amount_usd: 'must be a positive amount' });
    }
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingCredits)
        .values({
          orgId: input.orgId,
          kind: input.kind ?? 'grant',
          note: input.note?.slice(0, 256) ?? null,
          amountUsd: input.amountUsd.toFixed(6),
          remainingUsd: input.amountUsd.toFixed(6),
          expiresAt: input.expiresAt ?? null,
          grantedBy: input.grantedBy,
        })
        .returning(),
    );
    await this.audit.add({
      action: 'billing.credit_granted',
      resourceType: 'billing_credit',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.grantedBy,
      tenantId: input.orgId,
      details: { amount_usd: input.amountUsd.toFixed(2), kind: input.kind ?? 'grant', expires_at: input.expiresAt ?? null },
    });
    return inserted[0] as Record<string, unknown>;
  }

  async listCredits(orgId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(billingCredits).where(eq(billingCredits.orgId, orgId)).orderBy(asc(billingCredits.expiresAt)),
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      note: r.note,
      amount_usd: r.amountUsd,
      remaining_usd: r.remainingUsd,
      expires_at: r.expiresAt,
      created_at: r.createdAt,
    }));
  }

  async balance(orgId: string): Promise<string> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${billingCredits.remainingUsd}), 0)` })
        .from(billingCredits)
        .where(and(eq(billingCredits.orgId, orgId), or(isNull(billingCredits.expiresAt), gt(billingCredits.expiresAt, new Date().toISOString())))),
    );
    return (Number(rows[0]?.total ?? 0)).toFixed(2);
  }

  /**
   * Apply available credit against an invoice draft (oldest-expiring
   * first). Returns the applied total; records per-grant applications so
   * a void can return them. Call inside the org RLS context.
   */
  async applyToInvoice(tx: Parameters<Parameters<DbService['withOrg']>[1]>[0], orgId: string, invoiceId: string, grossUsd: number): Promise<number> {
    if (grossUsd <= 0) {
      return 0;
    }
    const now = new Date().toISOString();
    const available = await tx
      .select()
      .from(billingCredits)
      .where(and(eq(billingCredits.orgId, orgId), or(isNull(billingCredits.expiresAt), gt(billingCredits.expiresAt, now))))
      .orderBy(sql`${billingCredits.expiresAt} nulls last`, asc(billingCredits.createdAt));
    let remainingDue = grossUsd;
    let applied = 0;
    for (const credit of available) {
      if (remainingDue <= 0) {
        break;
      }
      const availableAmount = Number(credit.remainingUsd);
      if (availableAmount <= 0) {
        continue;
      }
      const use = Math.min(availableAmount, remainingDue);
      await tx
        .update(billingCredits)
        .set({ remainingUsd: (availableAmount - use).toFixed(6) })
        .where(eq(billingCredits.id, credit.id));
      await tx.insert(billingCreditApplications).values({ creditId: credit.id, invoiceId, appliedUsd: use.toFixed(6) });
      remainingDue -= use;
      applied += use;
    }
    return applied;
  }

  /** A voided invoice returns its credit to the grants (reversible money). */
  async returnCreditFromInvoice(orgId: string, invoiceId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      const applications = await tx.select().from(billingCreditApplications).where(eq(billingCreditApplications.invoiceId, invoiceId));
      for (const application of applications) {
        await tx
          .update(billingCredits)
          .set({ remainingUsd: sql`${billingCredits.remainingUsd} + ${application.appliedUsd}` })
          .where(eq(billingCredits.id, application.creditId));
        await tx.delete(billingCreditApplications).where(eq(billingCreditApplications.id, application.id));
      }
    });
  }

  // ── Line items + adjustments (draft-time document building) ──────────────

  /** Build the (kind × model) breakdown for an invoice period. */
  async buildLineItems(
    tx: Parameters<Parameters<DbService['withOrg']>[1]>[0],
    orgId: string,
    product: string,
    from: string,
    to: string,
    invoiceId: string,
  ): Promise<number> {
    const rows = await tx.execute<{ kind: string; model: string | null; events: number; tokens_in: number; tokens_out: number; cost_usd: string }>(sql`
      select kind, model, count(*)::int as events,
             coalesce(sum(tokens_in), 0)::int as tokens_in,
             coalesce(sum(tokens_out), 0)::int as tokens_out,
             coalesce(sum(cost_usd), 0)::text as cost_usd
      from billing.spend_events
      where org_id = ${orgId} and product = ${product}
        and occurred_at >= ${from}::timestamptz and occurred_at <= ${to}::timestamptz
      group by kind, model
      having coalesce(sum(cost_usd), 0) > 0
      order by coalesce(sum(cost_usd), 0) desc
    `);
    let total = 0;
    for (const row of rows.rows) {
      await tx.insert(billingInvoiceLines).values({
        invoiceId,
        kind: row.kind,
        model: row.model,
        events: row.events,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        amountUsd: Number(row.cost_usd).toFixed(6),
      });
      total += Number(row.cost_usd);
    }
    return total;
  }

  /** Consume pending adjustments for (org, product) onto this invoice. */
  async applyAdjustments(
    tx: Parameters<Parameters<DbService['withOrg']>[1]>[0],
    orgId: string,
    product: string,
    invoiceId: string,
  ): Promise<number> {
    const pending = await tx
      .select()
      .from(billingAdjustments)
      .where(and(eq(billingAdjustments.orgId, orgId), eq(billingAdjustments.product, product), isNull(billingAdjustments.appliedInvoiceId)));
    let net = 0;
    for (const adjustment of pending) {
      await tx.update(billingAdjustments).set({ appliedInvoiceId: invoiceId }).where(eq(billingAdjustments.id, adjustment.id));
      net += Number(adjustment.amountUsd);
    }
    return net;
  }

  async createAdjustment(input: { orgId: string; product: string; kind: string; amountUsd: number; reason: string; createdBy: string }): Promise<Record<string, unknown>> {
    const kinds = ['credit_note', 'debit_note', 'support_credit'];
    if (!kinds.includes(input.kind)) {
      throw ApiError.validation({ kind: `must be one of ${kinds.join(', ')}` });
    }
    if (!Number.isFinite(input.amountUsd) || input.amountUsd === 0 || Math.abs(input.amountUsd) > 100_000) {
      throw ApiError.validation({ amount_usd: 'must be a non-zero signed amount' });
    }
    if (input.kind === 'credit_note' && input.amountUsd > 0) {
      throw ApiError.validation({ amount_usd: 'a credit note is negative (reduces the next invoice)' });
    }
    if (input.kind === 'debit_note' && input.amountUsd < 0) {
      throw ApiError.validation({ amount_usd: 'a debit note is positive (adds to the next invoice)' });
    }
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingAdjustments)
        .values({
          orgId: input.orgId,
          product: input.product,
          kind: input.kind,
          amountUsd: input.amountUsd.toFixed(6),
          reason: input.reason.slice(0, 1024),
          createdBy: input.createdBy,
        })
        .returning(),
    );
    await this.audit.add({
      action: 'billing.adjustment_created',
      resourceType: 'billing_adjustment',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      productTag: input.product,
      details: { amount_usd: input.amountUsd.toFixed(2), kind: input.kind },
    });
    return inserted[0] as Record<string, unknown>;
  }

  // ── Budgets (B-3) ────────────────────────────────────────────────────────

  async createBudget(input: { orgId: string; product?: string | null; projectId?: string | null; monthlyUsd: number; thresholds?: number[]; createdBy: string }): Promise<Record<string, unknown>> {
    if (!Number.isFinite(input.monthlyUsd) || input.monthlyUsd <= 0 || input.monthlyUsd > 10_000_000) {
      throw ApiError.validation({ monthly_usd: 'must be a positive monthly amount' });
    }
    const thresholds = (input.thresholds ?? [50, 80, 100]).filter((t) => Number.isInteger(t) && t >= 10 && t <= 200).sort((a, b) => a - b);
    if (thresholds.length === 0) {
      throw ApiError.validation({ thresholds: 'at least one integer percent 10..200' });
    }
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingBudgets)
        .values({
          orgId: input.orgId,
          product: input.product ?? null,
          projectId: input.projectId ?? null,
          monthlyUsd: input.monthlyUsd.toFixed(2),
          thresholds,
          createdBy: input.createdBy,
        })
        .returning(),
    );
    await this.audit.add({
      action: 'billing.budget_created',
      resourceType: 'billing_budget',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      productTag: input.product ?? undefined,
      details: { monthly_usd: input.monthlyUsd.toFixed(2), thresholds },
    });
    return inserted[0] as Record<string, unknown>;
  }

  async listBudgets(orgId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(billingBudgets).where(eq(billingBudgets.orgId, orgId)));
    return rows.map((r) => ({
      id: r.id,
      product: r.product,
      project_id: r.projectId,
      name: r.name,
      monthly_usd: r.monthlyUsd,
      thresholds: r.thresholds,
      notified_percent: r.notifiedPercent,
    }));
  }

  async deleteBudget(orgId: string, budgetId: string, actorId: string): Promise<void> {
    const deleted = await this.db.withOrg(orgId, (tx) => tx.delete(billingBudgets).where(and(eq(billingBudgets.id, budgetId), eq(billingBudgets.orgId, orgId))).returning({ id: billingBudgets.id }));
    if (deleted.length === 0) {
      throw ApiError.notFound('budget');
    }
    await this.audit.add({ action: 'billing.budget_deleted', resourceType: 'billing_budget', resourceId: budgetId, actorType: 'account', actorId, tenantId: orgId });
  }

  /**
   * Evaluate every active budget against month-to-date spend. Alert each
   * crossed threshold exactly once per cycle. `spendLookup` is injected so
   * the quota plane stays the single usage-math authority.
   */
  async evaluateBudgets(spendLookup: (orgId: string, product: string | null, projectId: string | null) => Promise<number>, notify: NotificationsService): Promise<{ evaluated: number; alerted: number }> {
    const budgets = await this.db.withBypass((tx) => tx.select().from(billingBudgets));
    const cycle = new Date().toISOString().slice(0, 7);
    let alerted = 0;
    for (const budget of budgets) {
      const spend = await spendLookup(budget.orgId, budget.product, budget.projectId);
      const cap = Number(budget.monthlyUsd);
      if (cap <= 0) {
        continue;
      }
      const percent = Math.floor((spend / cap) * 100);
      const thresholds = (budget.thresholds as number[]) ?? [50, 80, 100];
      const crossed = thresholds.filter((t) => percent >= t);
      const alreadyNotified = budget.notifiedCycle === cycle ? budget.notifiedPercent : 0;
      const newCrossed = crossed.filter((t) => t > alreadyNotified);
      if (newCrossed.length > 0) {
        const highest = Math.max(...newCrossed);
        const severity = highest >= 100 ? 'error' : highest >= 80 ? 'warn' : 'info';
        await notify.notifyOrgRoles(budget.orgId, ['owner', 'admin', 'billing'], {
          kind: 'cost_anomaly',
          severity,
          title: `Budget ${percent}% used${budget.product ? ` (${budget.product})` : ''}`,
          body: `Month-to-date spend $${spend.toFixed(2)} of the $${cap.toFixed(2)} monthly budget (threshold ${highest}% crossed).`,
          data: { budget_id: budget.id, percent, threshold: highest },
        });
        await this.db.withOrg(budget.orgId, (tx) =>
          tx.update(billingBudgets).set({ notifiedPercent: highest, notifiedCycle: cycle }).where(eq(billingBudgets.id, budget.id)),
        );
        await this.audit.add({
          action: 'billing.budget_alert',
          resourceType: 'billing_budget',
          resourceId: budget.id,
          actorType: 'system',
          tenantId: budget.orgId,
          details: { percent, threshold: highest, spend_usd: spend.toFixed(2), cap_usd: cap.toFixed(2) },
        });
        alerted += 1;
      }
    }
    return { evaluated: budgets.length, alerted };
  }
}
