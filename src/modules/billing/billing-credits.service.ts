import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { NotificationsService } from '../notifications/notifications.service';
import { CREDIT_REPOSITORY, BUDGET_REPOSITORY, ADJUSTMENT_REPOSITORY } from './repositories/repository-tokens';
import type { ICreditRepository } from './repositories/credit.repository';
import type { IBudgetRepository } from './repositories/budget.repository';
import type { IAdjustmentRepository } from './repositories/adjustment.repository';

/**
 * The credits + budgets + adjustments service (gaps B-2/B-3/B-5/B-7):
 *
 *  - Credits: grants with expiry applied at invoice-draft time
 *    OLDEST-EXPIRING-FIRST; a void returns applied credit (money is
 *    reversible). Credit application runs atomically inside
 *    `IInvoiceDraftRepository.draftPeriodInvoice`.
 *  - Budgets: user-configured monthly USD caps with percent thresholds;
 *    the evaluation is called by the billing worker hourly — alerts land
 *    in the notification center (money roles) exactly once per threshold
 *    per cycle.
 *  - Adjustments: signed corrections consumed at draft time by
 *    `IInvoiceDraftRepository.draftPeriodInvoice`.
 *
 * Persistence lives behind the repository interfaces; this service owns
 * validation, audit, notification, and response shaping.
 */
@Injectable()
export class BillingCreditsService {
  private readonly logger = new Logger(BillingCreditsService.name);

  constructor(
    @Inject(CREDIT_REPOSITORY) private readonly credits: ICreditRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgets: IBudgetRepository,
    @Inject(ADJUSTMENT_REPOSITORY) private readonly adjustments: IAdjustmentRepository,
    private readonly audit: AuditService,
  ) {}

  // ── Credits ──────────────────────────────────────────────────────────────

  async grantCredit(input: { orgId: string; kind?: string; amountUsd: number; note?: string; expiresAt?: string | null; grantedBy: string }): Promise<Record<string, unknown>> {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0 || input.amountUsd > 1_000_000) {
      throw ApiError.validation({ amount_usd: 'must be a positive amount' });
    }
    const inserted = await this.credits.grantCredit({
      orgId: input.orgId,
      kind: input.kind,
      amountUsd: input.amountUsd,
      note: input.note?.slice(0, 256) ?? undefined,
      expiresAt: input.expiresAt ?? null,
      grantedBy: input.grantedBy,
    });
    await this.audit.add({
      action: 'billing.credit_granted',
      resourceType: 'billing_credit',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.grantedBy,
      tenantId: input.orgId,
      details: { amount_usd: input.amountUsd.toFixed(2), kind: input.kind ?? 'grant', expires_at: input.expiresAt ?? null },
    });
    return inserted as Record<string, unknown>;
  }

  async listCredits(orgId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.credits.listCredits(orgId);
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
    return this.credits.balance(orgId);
  }

  /** A voided invoice returns its credit to the grants (reversible money). */
  async returnCreditFromInvoice(orgId: string, invoiceId: string): Promise<void> {
    await this.credits.returnCreditFromInvoice(orgId, invoiceId);
  }

  // ── Adjustments ──────────────────────────────────────────────────────────

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
    const inserted = await this.adjustments.createAdjustment({
      orgId: input.orgId,
      product: input.product,
      kind: input.kind,
      amountUsd: input.amountUsd,
      reason: input.reason.slice(0, 1024),
      createdBy: input.createdBy,
    });
    await this.audit.add({
      action: 'billing.adjustment_created',
      resourceType: 'billing_adjustment',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      productTag: input.product,
      details: { amount_usd: input.amountUsd.toFixed(2), kind: input.kind },
    });
    return inserted as Record<string, unknown>;
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
    const inserted = await this.budgets.createBudget({
      orgId: input.orgId,
      product: input.product ?? null,
      projectId: input.projectId ?? null,
      monthlyUsd: input.monthlyUsd,
      thresholds,
      createdBy: input.createdBy,
    });
    await this.audit.add({
      action: 'billing.budget_created',
      resourceType: 'billing_budget',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      productTag: input.product ?? undefined,
      details: { monthly_usd: input.monthlyUsd.toFixed(2), thresholds },
    });
    return inserted as Record<string, unknown>;
  }

  async listBudgets(orgId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.budgets.listBudgets(orgId);
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
    const deleted = await this.budgets.deleteBudget(orgId, budgetId);
    if (!deleted) {
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
    const budgets = await this.budgets.listAllBudgets();
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
        await this.budgets.markBudgetNotified(budget.orgId, budget.id, highest, cycle);
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

/**
 * REL-9 F1 — pure invoice-derivation helpers. The canonical implementations
 * live in `./repositories/repository-types` (shared with the repository
 * lane); they are re-exported here so existing importers keep working.
 */
export { toLedgerLineKind, toLedgerLineNote } from './repositories/repository-types';

/** The previous calendar month as a half-open [from, to) ISO window. */
export function previousMonthWindow(now: Date): { from: string; to: string } {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: periodStart.toISOString(), to: periodEnd.toISOString() };
}
