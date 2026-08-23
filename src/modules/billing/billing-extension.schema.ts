import { index, integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * The billing extensions (gaps B-2/B-3/B-5/B-6/B-7 — the OpenAI/Stripe-grade
 * money surface): credits & grants, user-configured budgets with threshold
 * alerts, invoice line items, and adjustments (credit/debit notes).
 *
 * org_id varchar(36) matches tenants.id — reference by id, no cross-system
 * FK (partitioning §5). RLS per org_id (eng-0014, same policy shape).
 * Money columns are numeric — strings through JS, sums in SQL.
 */

/**
 * Billing credits (the OpenAI grants model): promotional/trial/purchased
 * balances applied against invoices OLDEST-grant-first at draft time.
 * `remaining_usd` is the live balance; applications are recorded per
 * invoice so a voided invoice RETURNS its credit (reversible money).
 */
export const billingCredits = pgTable('billing_credits', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  /** grant | trial | promotional | purchase */
  kind: varchar('kind', { length: 32 }).notNull().default('grant'),
  note: varchar('note', { length: 256 }),
  amountUsd: numeric('amount_usd', { precision: 12, scale: 6 }).notNull(),
  remainingUsd: numeric('remaining_usd', { precision: 12, scale: 6 }).notNull(),
  grantedBy: varchar('granted_by', { length: 128 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_billing_credits_org').on(t.orgId, t.expiresAt)]);

/** One application of (part of) a credit grant against one invoice. */
export const billingCreditApplications = pgTable('billing_credit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  creditId: uuid('credit_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  appliedUsd: numeric('applied_usd', { precision: 12, scale: 6 }).notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_billing_credit_apps_invoice').on(t.invoiceId)]);

/**
 * Budgets with threshold alerts (B-3 — the most-requested billing feature):
 * org-wide or scoped to a product/project; thresholds are percents of the
 * monthly budget; alert state (`notified_percent`) prevents re-alerting
 * within a cycle. Evaluated by the budget worker on the billing namespace.
 */
export const billingBudgets = pgTable('billing_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  product: varchar('product', { length: 64 }),
  projectId: uuid('project_id'),
  name: varchar('name', { length: 128 }).notNull().default('Monthly budget'),
  monthlyUsd: numeric('monthly_usd', { precision: 12, scale: 2 }).notNull(),
  thresholds: jsonb('thresholds').notNull().default([50, 80, 100]),
  /** Highest threshold percent already notified this cycle (reset monthly). */
  notifiedPercent: integer('notified_percent').notNull().default(0),
  notifiedCycle: varchar('notified_cycle', { length: 7 }),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_billing_budgets_org').on(t.orgId)]);

/**
 * Invoice line items (B-5): the chargeback-grade breakdown — one line per
 * (kind, model) with quantity/tokens/cost, generated at draft time from
 * the period's spend events. Immutable once drafted (a redraft deletes +
 * regenerates; the invoice is the snapshot).
 */
export const billingInvoiceLines = pgTable('billing_invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull(),
  /** Spend kind (inference | conversation | deployment_run | …). */
  kind: varchar('kind', { length: 32 }).notNull(),
  model: varchar('model', { length: 128 }),
  events: integer('events').notNull().default(0),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  unitPriceNote: varchar('unit_price_note', { length: 128 }),
  amountUsd: numeric('amount_usd', { precision: 12, scale: 6 }).notNull(),
}, (t) => [index('ix_billing_invoice_lines_invoice').on(t.invoiceId)]);

/**
 * Adjustments (B-7): manual credit/debit notes on a ledger with a reason —
 * the correction path for bad events short of voiding an invoice. Signed
 * amount (negative = credit). Applied at draft time after line items.
 */
export const billingAdjustments = pgTable('billing_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  product: varchar('product', { length: 64 }).notNull(),
  /** credit_note | debit_note | support_credit */
  kind: varchar('kind', { length: 32 }).notNull(),
  /** Signed USD: negative reduces the next invoice, positive adds. */
  amountUsd: numeric('amount_usd', { precision: 12, scale: 6 }).notNull(),
  reason: varchar('reason', { length: 1024 }).notNull(),
  /** Set when consumed by a draft; NULL = pending. */
  appliedInvoiceId: uuid('applied_invoice_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  index('ix_billing_adjustments_org_product').on(t.orgId, t.product),
  uniqueIndex('uq_billing_adjustments_applied').on(t.appliedInvoiceId),
]);
