import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Staff impersonation records (eng-0011): every support session minted by
 * the staff overlay — WHO impersonated WHOM, WHY, and the session id that
 * can be revoked. The audit chain carries the same facts; this table is
 * the OPERATIONAL view (list active, revoke one).
 *
 * Impersonation tokens are OP-signed RS256 JWTs carrying `imp: true` and
 * `act: {sub: staffAccountId}` — the L1 guard verifies them like any
 * session token (the oauth_sessions row exists), while the guards enforce
 * READ-ONLY: impersonated principals cannot step-up and cannot mutate
 * org-scoped resources.
 */
export const staffImpersonations = pgTable(
  'staff_impersonations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffAccountId: uuid('staff_account_id').notNull(),
    targetAccountId: uuid('target_account_id').notNull(),
    orgId: varchar('org_id', { length: 36 }),
    reason: varchar('reason', { length: 512 }).notNull(),
    sessionSid: varchar('session_sid', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_staff_impersonations_active').on(t.revokedAt, t.expiresAt),
    index('ix_staff_impersonations_staff').on(t.staffAccountId, t.createdAt),
  ],
);

export type ImpersonationRow = typeof staffImpersonations.$inferSelect;
