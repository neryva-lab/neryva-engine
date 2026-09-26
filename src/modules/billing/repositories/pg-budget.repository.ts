import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { billingBudgets } from '../billing-extension.schema';
import type { BillingBudgetRow } from './repository-types';
import type {
  CreateBudgetInput,
  IBudgetRepository,
} from './budget.repository';

/**
 * PostgreSQL `IBudgetRepository` (P3, B-3). Mechanical extraction of the
 * budget persistence from `BillingCreditsService` (`createBudget`,
 * `listBudgets`, `deleteBudget`, `evaluateBudgets`' reads/writes).
 *
 * Threshold/monthly-amount validation, the evaluation algorithm, and audit
 * stay in the service; the month-to-date spend lookup is injected
 * separately (backed by `ISpendEventRepository.monthlySpend`).
 */
@Injectable()
export class PgBudgetRepository implements IBudgetRepository {
  constructor(private readonly db: DbService) {}

  async createBudget(input: CreateBudgetInput): Promise<BillingBudgetRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingBudgets)
        .values({
          orgId: input.orgId,
          product: input.product ?? null,
          projectId: input.projectId ?? null,
          monthlyUsd: input.monthlyUsd.toFixed(2),
          thresholds: input.thresholds,
          createdBy: input.createdBy,
        })
        .returning(),
    );
    return inserted[0];
  }

  async listBudgets(orgId: string): Promise<BillingBudgetRow[]> {
    return this.db.withOrg(orgId, (tx) => tx.select().from(billingBudgets).where(eq(billingBudgets.orgId, orgId)));
  }

  async deleteBudget(orgId: string, budgetId: string): Promise<boolean> {
    const deleted = await this.db.withOrg(orgId, (tx) =>
      tx.delete(billingBudgets).where(and(eq(billingBudgets.id, budgetId), eq(billingBudgets.orgId, orgId))).returning({ id: billingBudgets.id }),
    );
    return deleted.length > 0;
  }

  async listAllBudgets(): Promise<BillingBudgetRow[]> {
    return this.db.withBypass((tx) => tx.select().from(billingBudgets));
  }

  async markBudgetNotified(orgId: string, budgetId: string, percent: number, cycle: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx.update(billingBudgets).set({ notifiedPercent: percent, notifiedCycle: cycle }).where(eq(billingBudgets.id, budgetId)),
    );
  }
}
