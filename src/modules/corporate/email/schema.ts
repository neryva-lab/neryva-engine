import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Delivery audit rows for every outbound email (corporate E-1). One row per
 * send attempt — the durable record that identity's login codes and org
 * invites were actually dispatched. Engine-owned from creation (eng-0001).
 */
export const emailDeliveries = pgTable('email_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  template: varchar('template', { length: 64 }).notNull(),
  recipient: varchar('recipient', { length: 320 }).notNull(),
  subject: text('subject').notNull(),
  transport: varchar('transport', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(), // sent | failed
  error: text('error'),
  metadata: jsonb('metadata').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_email_deliveries_recipient_created').on(t.recipient, t.created_at)]);
