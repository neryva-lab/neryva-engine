/**
 * `IAccountRepository` — the persistence port for the `accounts` table (P3).
 *
 * Platform-plane / GLOBAL: identity tables are NOT tenant-scoped and carry
 * no RLS (`src/modules/identity/schema.ts`). Every method is keyed by
 * `accountId` (or email); no `orgId` parameter exists on purpose.
 *
 * Behavioral truth: `src/modules/identity/accounts.service.ts`,
 * `src/modules/identity/account-deletion.service.ts`,
 * `src/modules/identity/email-change.service.ts`,
 * `src/modules/identity/social/social-account.service.ts` (creation
 * attributes: `createdVia`, `emailVerifiedAt`, `displayName`).
 */
export interface Account {
  id: string;
  email: string;
  displayName: string | null;
  emailVerifiedAt: string | null;
  mfaLevel: string;
  status: string;
  createdVia: string;
  lastLoginAt: string | null;
  sessionsRevokedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creation-time attributes for `upsertByEmail`, honored only when the call
 * actually inserts (never applied to a pre-existing row). Absent fields
 * fall back to the lane's plain-origin defaults (`email_code`,
 * NULL `email_verified_at`, email-derived display name).
 */
export interface AccountCreateAttrs {
  /** Origin marker, e.g. `social:google` — backs the one-way binding rule. */
  createdVia?: string;
  /** ISO instant the IdP asserted email verification (NULL = unverified). */
  emailVerifiedAt?: string | null;
  /** Display name; the lane slices to the 256-char column width. */
  displayName?: string;
}

export interface IAccountRepository {
  /** Case-insensitive lookup (citext on the pg lane; collated unique index on mongo). */
  findByEmail(email: string): Promise<Account | null>;
  findById(accountId: string): Promise<Account | null>;
  /**
   * Insert-or-read for just-in-time account creation. Returns the account
   * and whether THIS call created it. Preserves the insert-race behavior:
   * a lost insert race re-reads the winner's row (and may surface a
   * non-active row — the caller enforces the active gate).
   *
   * `attrs` is honored ONLY on the creation path (a pre-existing row is
   * never mutated — the pre-port `onConflictDoNothing` semantics). The
   * social-account flow passes its creation attributes through here so the
   * one-way binding rule (`created_via = 'social:*'`) survives the port.
   */
  upsertByEmail(email: string, attrs?: AccountCreateAttrs): Promise<{ account: Account; created: boolean }>;
  markLoginSuccess(accountId: string, nowIso: string): Promise<void>;
  markEmailVerified(accountId: string, nowIso: string): Promise<void>;
  updateDisplayName(accountId: string, displayName: string): Promise<void>;
  /**
   * Global session kill-switch: stamps `sessions_revoked_at` (the L1 guard
   * compares iat against it; the refresh lane rejects tokens created before
   * it) and marks the account's session rows revoked so `listActive` stops
   * presenting them as live sessions. The caller emits the
   * `session.all_revoked` event afterwards (out-of-TX, as before).
   */
  revokeAllSessions(accountId: string, nowIso: string): Promise<void>;
  /**
   * Atomic email swap for the email-change flow. Throws an error with
   * `code === '23505'` when the new email is already taken (both lanes —
   * the mongo lane emulates the pg unique-violation code).
   */
  swapEmail(accountId: string, newEmail: string): Promise<void>;
  setScheduledDeletion(accountId: string, scheduledPurgeAt: string): Promise<void>;
  clearScheduledDeletion(accountId: string): Promise<void>;
  findDeletionSchedule(accountId: string): Promise<{ deletedAt: string | null } | null>;
  /** Account ids whose `deleted_at` has passed (the purge worker's input). */
  listPurgeDue(nowIso: string, limit: number): Promise<string[]>;
  /**
   * Administrative cross-tenant purge: deletes the account's grants, its
   * notifications, ALL of its org memberships (every tenant — the
   * documented bypass), then the account row itself (dependent rows fall
   * away by FK cascade on the pg lane). One method, one documented
   * administrative unit.
   */
  purgeAccount(accountId: string): Promise<void>;
  /**
   * The session-registry guard state: the account's status plus the
   * kill-switch stamp. Used by `isSessionActive` and the refresh-grant
   * kill-switch check.
   */
  sessionGuardState(accountId: string): Promise<{ status: string; sessionsRevokedAt: string | null } | null>;
}
