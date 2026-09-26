/**
 * `IPlatformStaffRepository` — the persistence port for the `platform_staff`
 * table (P3).
 *
 * Platform-plane (no RLS — the staff binding is the authority for the
 * staff axis). Repository methods are keyed by `accountId`, never by
 * `orgId`.
 *
 * Behavioral truth: `src/modules/staff/platform-staff.admin.ts` (`upsert`
 * with `onConflictDoUpdate`, `findByPk`, `revoke`, `list` with the
 * accounts left-join, `countActiveSuperAdmins`).
 */

export type PlatformStaffRole = 'super_admin' | 'tenant_admin' | 'operator' | 'auditor';

export interface PlatformStaff {
  accountId: string;
  role: string;
  grantedBy: string | null;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface PlatformStaffListRow {
  accountId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface UpsertPlatformStaffInput {
  accountId: string;
  role: PlatformStaffRole;
  expiresAt: string | null;
  grantedBy: string | null;
  nowIso: string;
}

export interface IPlatformStaffRepository {
  /**
   * Insert-or-update the staff binding (the pg lane's
   * `onConflictDoUpdate` on `account_id`: role/granted_by/granted_at/
   * expires_at refreshed, revoked_at + revoke_reason cleared). Returns
   * the resulting rows.
   */
  upsert(input: UpsertPlatformStaffInput): Promise<PlatformStaff[]>;
  /** Lookup by account id (the primary key). */
  findByAccountId(accountId: string): Promise<PlatformStaff | null>;
  /** Mark the binding revoked with an optional reason. */
  revoke(accountId: string, reason: string | null, nowIso: string): Promise<void>;
  /**
   * All bindings with the account's email/display name (the pg lane's
   * left-join against `accounts`).
   */
  list(): Promise<PlatformStaffListRow[]>;
  /** Count of active (unrevoked, unexpired) super_admin bindings. */
  countActiveSuperAdmins(nowIso: string): Promise<number>;
}
