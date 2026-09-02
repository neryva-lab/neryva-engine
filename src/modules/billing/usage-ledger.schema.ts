import { bigint, index, integer, jsonb, numeric, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Phase 8 persistence (drizzle/0027_billing_ledger.sql). The usage ledger is
 * append-only (invariant 9): corrections are compensating entries linked by
 * `reversal_of` — history is NEVER rewritten.
 */

export const usageLedgerEntries = pgTable(
  'usage_ledger_entries',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    usageEventId: varchar('usage_event_id', { length: 128 }).notNull(),
    sourceType: varchar('source_type', { length: 32 }).notNull(),
    sourceId: varchar('source_id', { length: 128 }),
    runId: uuid('run_id'),
    messageId: uuid('message_id'),
    usageKind: varchar('usage_kind', { length: 32 }).notNull(),
    unit: varchar('unit', { length: 32 }).notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull(),
    provider: varchar('provider', { length: 64 }),
    model: varchar('model', { length: 128 }),
    estimatedCost: numeric('estimated_cost', { precision: 20, scale: 6 }),
    settledCost: numeric('settled_cost', { precision: 20, scale: 6 }),
    currency: varchar('currency', { length: 8 }).notNull().default('USD'),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    reversalOf: uuid('reversal_of'),
    /** pending | matched | discrepant | corrected */
    reconciliationState: varchar('reconciliation_state', { length: 32 }).notNull().default('pending'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_usage_ledger_run').on(t.organizationId, t.runId), index('ix_usage_ledger_created').on(t.organizationId, t.createdAt)],
);

export const quotaReservations = pgTable(
  'quota_reservations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    dimension: varchar('dimension', { length: 32 }).notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull(),
    /** RESERVED | COMMITTED | RELEASED | EXPIRED */
    state: varchar('state', { length: 32 }).notNull().default('RESERVED'),
    runId: uuid('run_id'),
    reference: varchar('reference', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true, mode: 'string' }),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [index('ix_quota_reservations_org_dim').on(t.organizationId, t.dimension, t.state)],
);

export const providerReconciliationRuns = pgTable('provider_reconciliation_runs', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull(),
  provider: varchar('provider', { length: 64 }).notNull(),
  /** running | completed | failed */
  state: varchar('state', { length: 32 }).notNull().default('running'),
  entriesChecked: integer('entries_checked').notNull().default(0),
  discrepancies: integer('discrepancies').notNull().default(0),
  resultRef: jsonb('result_ref'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
});

export const billingWebhookInbox = pgTable('billing_webhook_inbox', {
  id: uuid('id').primaryKey(),
  provider: varchar('provider', { length: 32 }).notNull(),
  providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
  /** received → signature_validated → deduplicated → processed | rejected | reconciliation_required */
  state: varchar('state', { length: 32 }).notNull().default('received'),
  signatureResult: varchar('signature_result', { length: 32 }),
  payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  payloadRef: jsonb('payload_ref'),
  processingResult: jsonb('processing_result'),
  /** none | required | completed */
  reconciliationStatus: varchar('reconciliation_status', { length: 32 }).notNull().default('none'),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
});

export type UsageLedgerEntry = typeof usageLedgerEntries.$inferSelect;
export type QuotaReservation = typeof quotaReservations.$inferSelect;
export type BillingWebhookInboxRow = typeof billingWebhookInbox.$inferSelect;
