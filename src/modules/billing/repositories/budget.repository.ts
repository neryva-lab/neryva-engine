/**
 * `IBudgetRepository` — the budgets aggregate (P3, B-3).
 *
 * User-configured monthly USD caps with percent thresholds; alert state
 * (`notified_percent` / `notified_cycle`) prevents re-alerting within a
 * cycle.
 *
 * Each method owns one transaction: org-scoped for the CRUD paths,
 * bypass for `listAllBudgets` (the worker evaluates EVERY org's budgets —
 * explicitly cross-tenant).
 *
 * What stays OUT: threshold/monthly-amount validation, the evaluation
 * algorithm (percent math, crossed-threshold detection, notification
 * fan-out — the service), the month-to-date spend lookup (injected
 * `spendLookup` backed by `ISpendEventRepository.monthlySpend`), and audit
 * writes (replayed by the service).
 */
import type { BillingBudgetRow } from './repository-types';

export interface CreateBudgetInput {
  orgId: string;
  product?: string | null;
  projectId?: string | null;
  monthlyUsd: number;
  thresholds: number[];
  createdBy: string;
}

export interface IBudgetRepository {
  createBudget(input: CreateBudgetInput): Promise<BillingBudgetRow>;

  listBudgets(orgId: string): Promise<BillingBudgetRow[]>;

  /** Returns false when the budget does not exist (the service maps to not_found). */
  deleteBudget(orgId: string, budgetId: string): Promise<boolean>;

  /** Every budget in the system — the worker's evaluation read. */
  listAllBudgets(): Promise<BillingBudgetRow[]>;

  /** Record the highest threshold notified this cycle. */
  markBudgetNotified(orgId: string, budgetId: string, percent: number, cycle: string): Promise<void>;
}
