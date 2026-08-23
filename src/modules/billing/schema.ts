import { index, integer, jsonb, numeric, pgSchema, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * The engine metering plane (ledger billing-metering B-1/B-2, eng-0004).
 *
 * Tables live in the dedicated `billing` schema: the Python runtime's
 * public.spend_events remains runtime-owned until the A-3 handover — the
 * ownership map forbids two systems owning one table, so the engine's
 * ingest lands in ITS OWN tables from creation. During the B-4 dual-write
 * window both tables exist side by side; reconciliation compares them.
 *
 * org_id is varchar(36) matching the Python-owned tenants.id — reference by
 * id, never by FK across system boundaries (partitioning §5). RLS isolates
 * by org_id (see eng-0004).
 */
export const billingSchema = pgSchema('billing');

/**
 * One spend event = one metered unit of product consumption pushed by a
 * satellite (or emitted by an engine module). Idempotency is (source,
 * event_id): a satellite retrying a push never double-bills. The six-level
 * partitioning hierarchy (partitioning §3 / P-2) maps to columns:
 *   platform (implicit) > tenant (org_id) > product > project_id
 *   > surface > end_user_id
 */
export const spendEvents = billingSchema.table(
  'spend_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The emitter's own id for this event — idempotency key half. */
    eventId: varchar('event_id', { length: 160 }).notNull(),
    /** The emitting service client (L3 sub / client id) — idempotency key half. */
    source: varchar('source', { length: 64 }).notNull(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    product: varchar('product', { length: 64 }).notNull(),
    projectId: uuid('project_id'),
    surface: varchar('surface', { length: 128 }),
    endUserId: varchar('end_user_id', { length: 64 }),
    /** Consumption kind: inference | conversation | job | tool | … (product-defined). */
    kind: varchar('kind', { length: 32 }).notNull().default('inference'),
    model: varchar('model', { length: 128 }),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** Cost in USD the platform charges the org for this event. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    meta: jsonb('meta').notNull().default({}),
    /** When the consumption happened (satellite clock) vs ingested_at (engine clock). */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_billing_spend_source_event').on(t.source, t.eventId),
    index('ix_billing_spend_org_product_time').on(t.orgId, t.product, t.occurredAt),
    index('ix_billing_spend_org_project').on(t.orgId, t.projectId),
    index('ix_billing_spend_org_time').on(t.orgId, t.occurredAt),
  ],
);

/**
 * Invoice records (M-3): per (org × product) — the ADR-001 partitioning
 * rule. Payment-provider integration is explicitly out of scope; these are
 * ledger records with a small status machine (draft → issued → paid, any →
 * void), every transition audited.
 */
export const billingInvoices = billingSchema.table(
  'billing_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    product: varchar('product', { length: 64 }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }).notNull(),
    /** draft | issued | paid | void */
    status: varchar('status', { length: 16 }).notNull().default('draft'),
    totalUsd: numeric('total_usd', { precision: 12, scale: 2 }).notNull().default('0'),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'string' }),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_billing_invoices_org_product_period').on(t.orgId, t.product, t.periodStart),
    index('ix_billing_invoices_org_status').on(t.orgId, t.status),
  ],
);

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Explicit invoice transitions — anything else is a conflict. */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['issued', 'void'],
  issued: ['paid', 'void'],
  paid: ['void'],
  void: [],
};

export type SpendEventRow = typeof spendEvents.$inferSelect;
export type NewSpendEvent = typeof spendEvents.$inferInsert;
export type InvoiceRow = typeof billingInvoices.$inferSelect;

/**
 * The platform price catalog (the B-1 trust fix): what a unit of
 * consumption COSTS the org, owned by the platform — satellite-reported
 * cost_usd is advisory input, never billing truth. Rows are effective-
 * windowed versions (a price change adds a new row; lookups resolve the
 * row effective at the event's occurred_at). Model-specific rows (per-
 * million token prices) coexist with event-priced rows (price_per_event
 * for tokenless kinds like deployment runs). No RLS: platform-plane
 * pricing, staff-managed, read by the ingest path.
 */
export const priceCatalog = billingSchema.table(
  'price_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    product: varchar('product', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    /** NULL model = the default row for the (product, kind). */
    model: varchar('model', { length: 128 }),
    /** USD per 1M input tokens (model rows). */
    pricePerMillionInputUsd: numeric('price_per_million_input_usd', { precision: 12, scale: 6 }),
    /** USD per 1M output tokens (model rows). */
    pricePerMillionOutputUsd: numeric('price_per_million_output_usd', { precision: 12, scale: 6 }),
    /** USD per event (tokenless kinds — e.g. a deployment run). */
    pricePerEventUsd: numeric('price_per_event_usd', { precision: 12, scale: 6 }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'string' }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'string' }),
    note: varchar('note', { length: 256 }),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_price_catalog_slot').on(t.product, t.kind, t.model, t.effectiveFrom),
    index('ix_price_catalog_lookup').on(t.product, t.kind, t.model, t.effectiveFrom),
  ],
);

export type PriceRow = typeof priceCatalog.$inferSelect;
