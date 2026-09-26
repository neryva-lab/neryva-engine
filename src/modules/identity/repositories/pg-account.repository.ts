import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accounts, oauthGrants, oauthSessions } from '../schema';
import type { Account, AccountCreateAttrs, IAccountRepository } from './account.repository';

/**
 * PostgreSQL implementation of `IAccountRepository` (P3).
 *
 * Mechanical move of the `accounts`-table units from
 * `AccountsService` (find/upsert/mark/revoke), `EmailChangeService`
 * (`swapEmail`), `AccountDeletionService` (schedule/clear/list/purge), and
 * `OidcDrizzleAdapter` (`sessionGuardState`).
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 *
 * What stays OUT (still the caller's job): audit writes, event emission,
 * the insert-race active-gate (the caller enforces it), the unique-violation
 * → conflict mapping on `swapEmail` (the raw `23505` propagates, as the
 * contract requires), and the deletion-confirmation policy.
 */
export class PgAccountRepository implements IAccountRepository {
  constructor(private readonly db: DbService) {}

  /** Case-insensitive lookup — the `email` column is citext. */
  async findByEmail(email: string): Promise<Account | null> {
    const rows = await this.db.root
      .select()
      .from(accounts)
      .where(eq(accounts.email, normalizeEmail(email)))
      .limit(1);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async findById(accountId: string): Promise<Account | null> {
    const rows = await this.db.root
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  /**
   * Insert-or-read for just-in-time account creation. A lost insert race
   * re-reads the winner's row (which may be non-active — the caller
   * enforces the active gate, as before). Creation attributes apply only
   * to the inserted row; a pre-existing row is never touched.
   */
  async upsertByEmail(email: string, attrs: AccountCreateAttrs = {}): Promise<{ account: Account; created: boolean }> {
    const normalized = normalizeEmail(email);
    const existing = await this.findByEmail(normalized);
    if (existing) {
      return { account: existing, created: false };
    }
    const inserted = await this.db.root
      .insert(accounts)
      .values({
        email: normalized,
        emailVerifiedAt: attrs.emailVerifiedAt ?? null,
        displayName: (attrs.displayName ?? normalized.split('@')[0] ?? normalized).slice(0, 256),
        ...(attrs.createdVia !== undefined ? { createdVia: attrs.createdVia } : {}),
      })
      .onConflictDoNothing({ target: accounts.email })
      .returning();
    if (inserted[0]) {
      return { account: toAccount(inserted[0]), created: true };
    }
    // Lost an insert race — the winner's row is the truth.
    const raced = await this.findByEmail(normalized);
    if (!raced) {
      throw new Error('account upsert race produced no row');
    }
    return { account: raced, created: false };
  }

  async markLoginSuccess(accountId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(accounts)
      .set({ lastLoginAt: nowIso })
      .where(eq(accounts.id, accountId));
  }

  /** First successful email-code login proves the mailbox. */
  async markEmailVerified(accountId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(accounts)
      .set({ emailVerifiedAt: nowIso })
      .where(eq(accounts.id, accountId));
  }

  async updateDisplayName(accountId: string, displayName: string): Promise<void> {
    await this.db.root
      .update(accounts)
      .set({ displayName, updatedAt: new Date().toISOString() })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Global session kill-switch: the L1 guard compares iat against the
   * stamped `sessions_revoked_at`, and the refresh lane rejects tokens
   * created before it. The session rows are marked revoked in the same
   * transaction so `listActive` (which filters `revoked_at IS NULL`) stops
   * presenting them as live sessions.
   */
  async revokeAllSessions(accountId: string, nowIso: string): Promise<void> {
    await this.db.root.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({ sessionsRevokedAt: nowIso })
        .where(eq(accounts.id, accountId));
      await tx
        .update(oauthSessions)
        .set({ revokedAt: nowIso })
        .where(and(eq(oauthSessions.accountId, accountId), isNull(oauthSessions.revokedAt)));
    });
  }

  /**
   * Atomic email swap: the citext unique index settles races — the loser
   * surfaces as a `23505` unique violation, which propagates untouched for
   * the caller to map to a conflict.
   */
  async swapEmail(accountId: string, newEmail: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.root.transaction(async (tx) => {
      const updated = await tx
        .update(accounts)
        .set({ email: newEmail, emailVerifiedAt: now, updatedAt: now })
        .where(eq(accounts.id, accountId))
        .returning({ id: accounts.id });
      if (!updated[0]) {
        throw new Error('email swap produced no row');
      }
    });
  }

  async setScheduledDeletion(accountId: string, scheduledPurgeAt: string): Promise<void> {
    await this.db.root
      .update(accounts)
      .set({ deletedAt: scheduledPurgeAt, updatedAt: new Date().toISOString() })
      .where(eq(accounts.id, accountId));
  }

  async clearScheduledDeletion(accountId: string): Promise<void> {
    await this.db.root
      .update(accounts)
      .set({ deletedAt: null, updatedAt: new Date().toISOString() })
      .where(and(eq(accounts.id, accountId), eq(accounts.status, 'active')));
  }

  async findDeletionSchedule(accountId: string): Promise<{ deletedAt: string | null } | null> {
    const rows = await this.db.root
      .select({ deletedAt: accounts.deletedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Account ids whose `deleted_at` has passed (the purge worker's input). */
  async listPurgeDue(nowIso: string, limit: number): Promise<string[]> {
    const rows = await this.db.root
      .select({ id: accounts.id })
      .from(accounts)
      .where(lte(accounts.deletedAt, nowIso))
      .orderBy(asc(accounts.deletedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * Administrative cross-tenant purge, in the exact statement order of the
   * service: grants first (no FK to accounts), then notifications, then the
   * cross-org membership sweep under the documented bypass, then the
   * account row itself (dependent rows fall away by FK cascade).
   */
  async purgeAccount(accountId: string): Promise<void> {
    // Grants carry no FK to accounts — explicit delete first (sessions and
    // everything under the account row go with the final DELETE's cascade).
    await this.db.root.delete(oauthGrants).where(eq(oauthGrants.accountId, accountId));
    await this.db.root.execute(sql`delete from notifications where account_id = ${accountId}`);
    // Justification (withBypass): the purge sweeps the account out of every
    // org at once — an explicitly administrative, cross-tenant delete.
    await this.db.withBypass(async (tx) => {
      await tx.execute(sql`delete from org_group_members where account_id = ${accountId}`);
      await tx.execute(sql`delete from org_memberships where account_id = ${accountId}`);
    });
    await this.db.root.delete(accounts).where(eq(accounts.id, accountId));
  }

  /** The session-registry guard state: status plus the kill-switch stamp. */
  async sessionGuardState(
    accountId: string,
  ): Promise<{ status: string; sessionsRevokedAt: string | null } | null> {
    const rows = await this.db.root
      .select({ status: accounts.status, sessionsRevokedAt: accounts.sessionsRevokedAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return rows[0] ?? null;
  }
}

/**
 * pg-lane row → domain. `deleted_at` IS the scheduled-purge deadline on pg
 * (drizzle/0018 sets it to the grace-window deadline).
 */
function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    emailVerifiedAt: row.emailVerifiedAt,
    mfaLevel: row.mfaLevel,
    status: row.status,
    createdVia: row.createdVia,
    lastLoginAt: row.lastLoginAt,
    sessionsRevokedAt: row.sessionsRevokedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * citext makes this redundant on pg, but it documents the invariant the
 * unique index relies on.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
