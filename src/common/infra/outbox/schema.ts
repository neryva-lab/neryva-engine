import { integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Transactional outbox — Phase 4 (pinned decision: table lands with Phase 4,
 * the generic dispatcher ROLE is Phase 6). State machine is the pinned
 * PENDING -> CLAIMED -> PUBLISHED -> RETRY_WAIT -> DEAD_LETTER.
 * Rows are ONLY inserted by `recordOutboxEvent` inside the same transaction
 * as the canonical fact they announce (invariant 7, engine_architecture.md:584).
 */
export const outboxEvents = pgTable('outbox_events', {
  eventId: uuid('event_id').primaryKey(),
  aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  eventVersion: integer('event_version').notNull().default(1),
  payload: jsonb('payload'),
  partitionKey: varchar('partition_key', { length: 128 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  traceId: varchar('trace_id', { length: 64 }),
  correlationId: uuid('correlation_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  /** Dispatcher claim lease (drizzle/0025_outbox_dispatch.sql) — stale claims recover to PENDING. */
  claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'string' }),
  lastError: varchar('last_error', { length: 4096 }),
});

/**
 * Consumer dedup ledger — platform-plane by design: keyed per consumer, no
 * tenant rows, no RLS (documented in drizzle/0023_async_foundation.sql and
 * ownership-map.json). Consumers claim `(consumer_name, event_id)` in the
 * same transaction as their side effect.
 */
export const inboxEvents = pgTable('inbox_events', {
  consumerName: varchar('consumer_name', { length: 128 }).notNull(),
  eventId: uuid('event_id').notNull(),
  status: varchar('status', { length: 32 }).notNull().default('RECEIVED'),
  firstReceivedAt: timestamp('first_received_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lastReceivedAt: timestamp('last_received_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
  resultRef: jsonb('result_ref'),
  lastError: varchar('last_error', { length: 4096 }),
});

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type InboxEvent = typeof inboxEvents.$inferSelect;

export const OUTBOX_STATUSES = ['PENDING', 'CLAIMED', 'PUBLISHED', 'RETRY_WAIT', 'DEAD_LETTER'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
