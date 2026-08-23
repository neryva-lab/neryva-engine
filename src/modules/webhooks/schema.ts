import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Outbound webhooks (gap P-1/S-1, eng-0011): per-org customer endpoints
 * receiving platform events with HMAC-SHA256 signatures, bounded retries,
 * and a durable delivery log. RLS per org_id (eng-0011 policies).
 *
 * The signing secret is envelope-encrypted (enc:v1:) and returned to the
 * caller exactly once at creation — there is no read-back path, same
 * discipline as API keys.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    /** Event subscriptions: exact event types or ['*']. */
    events: jsonb('events').notNull().default([]),
    url: text('url').notNull(),
    /** enc:v1: envelope — never plaintext at rest. */
    secretEnvelope: text('secret_envelope').notNull(),
    description: varchar('description', { length: 256 }),
    /** active | disabled */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_webhooks_org').on(t.orgId, t.status)],
);

/**
 * One row per delivery attempt chain. Attempts share a row (attempt count
 * + next_attempt_at); the terminal states are delivered | dead. Retention:
 * 30 days (the cleanup job is a hardening item, listed).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    /** pending | delivered | failed | dead */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 512 }),
    responseStatus: integer('response_status'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_webhook_deliveries_org_created').on(t.orgId, t.createdAt),
    index('ix_webhook_deliveries_pending').on(t.status, t.nextAttemptAt),
    index('ix_webhook_deliveries_webhook').on(t.webhookId, t.createdAt),
  ],
);

export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
