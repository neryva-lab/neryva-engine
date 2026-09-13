import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Platform staff binding (auth_plan.md D1, drizzle/0043): the AUTHORITY for
 * the staff axis. Staff are regular accounts with a staff binding row — never
 * a different species of user and never a column on `accounts`.
 *
 * This schema lives in the kernel (the `idempotency_records` precedent:
 * common/http/idempotency-records.ts) because the directory is a kernel-level
 * provider — PlatformStaffGuard is hosted by several modules (staff,
 * satellites, billing) and every context must resolve the same port. The
 * kernel imports no module, so the `account_id` FK to `accounts(id)` is
 * declared in the migration SQL (authoritative) and NOT via `.references()`
 * here — the `legacy-schema.ts` pattern for platform-plane tables.
 *
 * Platform-plane in the `accounts` posture: NOT tenant-scoped, no RLS, the
 * engine is the only writer, every grant/revoke audited (staff.role_granted /
 * staff.role_revoked). `granted_by` NULL marks a system/bootstrap grant
 * (PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS). `expires_at` is the JIT lever: expired
 * grants resolve to nothing. Resolution is per request through
 * PlatformStaffDirectoryPort (60s cache, invalidated on transition) — the L1
 * JWT `platform_role` claim is an optimization only, never authoritative.
 */
export const platformStaff = pgTable('platform_staff', {
  /** FK → accounts(id) ON DELETE CASCADE (drizzle/0043_platform_staff.sql). */
  accountId: uuid('account_id').primaryKey(),
  /** super_admin | tenant_admin | operator | auditor */
  role: varchar('role', { length: 16 }).notNull(),
  grantedBy: uuid('granted_by'),
  grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  revokeReason: varchar('revoke_reason', { length: 512 }),
});

export type PlatformStaffRow = typeof platformStaff.$inferSelect;
