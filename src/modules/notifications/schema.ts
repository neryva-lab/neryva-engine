import { index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * In-app notifications (gap P-2, eng-0011): the account-facing feed every
 * alerting path (anomalies, entitlement trouble, ownership/role changes,
 * deployment outcomes, dead webhooks) writes to, with optional email
 * fan-out for warn/error severity. Platform-plane table (no RLS — the
 * engine is the only writer; reads are explicit account_id filters, same
 * posture as oauth_sessions).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The recipient account (org-targeted rows fan out to members). */
    accountId: uuid('account_id').notNull(),
    orgId: varchar('org_id', { length: 36 }),
    /** Machine kind: billing.anomaly | entitlement.past_due | org.role_changed | … */
    kind: varchar('kind', { length: 64 }).notNull(),
    /** info | warn | error */
    severity: varchar('severity', { length: 8 }).notNull().default('info'),
    title: varchar('title', { length: 160 }).notNull(),
    body: varchar('body', { length: 1024 }).notNull().default(''),
    data: jsonb('data').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_notifications_account_created').on(t.accountId, t.createdAt),
    index('ix_notifications_org').on(t.orgId, t.createdAt),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
