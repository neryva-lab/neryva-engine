import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accountCredentials, accountRecoveryCodes, accounts } from '../schema';
import type { IMfaRepository, TotpCredential } from './mfa.repository';

const TOTP_KIND = 'totp';
const TOTP_PENDING_KIND = 'totp_pending';

/**
 * PostgreSQL implementation of `IMfaRepository` (P3).
 *
 * Mechanical move of the MFA units from `MfaService`: the active/pending
 * TOTP factor rows in `account_credentials`, the `account_recovery_codes`
 * lifecycle, and the `accounts.mfa_level` transitions.
 *
 * The multi-row transitions (`activate`, `disable`,
 * `regenerateRecoveryCodes`) each own their transaction — callers never
 * see a transaction handle. Crypto (envelope encrypt/decrypt, code
 * generation) stays with the caller; this port carries the opaque envelope
 * string and the pre-hashed recovery codes.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgMfaRepository implements IMfaRepository {
  constructor(private readonly db: DbService) {}

  /** The active TOTP factor, or null when MFA is not active. */
  async findActive(accountId: string): Promise<TotpCredential | null> {
    const rows = await this.db.root
      .select()
      .from(accountCredentials)
      .where(
        and(
          eq(accountCredentials.accountId, accountId),
          eq(accountCredentials.kind, TOTP_KIND),
          isNull(accountCredentials.revokedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toTotpCredential(rows[0]) : null;
  }

  /** The pending (enrolled-but-not-yet-activated) TOTP factor, or null. */
  async findPending(accountId: string): Promise<TotpCredential | null> {
    const rows = await this.db.root
      .select()
      .from(accountCredentials)
      .where(
        and(
          eq(accountCredentials.accountId, accountId),
          eq(accountCredentials.kind, TOTP_PENDING_KIND),
        ),
      )
      .limit(1);
    return rows[0] ? toTotpCredential(rows[0]) : null;
  }

  /**
   * Insert-or-replace the pending enrollment secret: insert on conflict-do-
   * nothing, then update the row when the insert lost (the pending row
   * already existed).
   */
  async enrollPending(accountId: string, secretEnvelope: string): Promise<void> {
    const envelope = { secret: secretEnvelope };
    const inserted = await this.db.root
      .insert(accountCredentials)
      .values({ accountId, kind: TOTP_PENDING_KIND, envelope })
      .onConflictDoNothing({
        // The (account, kind) unique index is PARTIAL (WHERE kind <>
        // 'webauthn') — the conflict target must carry the implying
        // predicate or inference fails.
        target: [accountCredentials.accountId, accountCredentials.kind],
        where: eq(accountCredentials.kind, TOTP_PENDING_KIND),
      })
      .returning({ id: accountCredentials.id });
    if (inserted.length === 0) {
      await this.db.root
        .update(accountCredentials)
        .set({ envelope, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(accountCredentials.accountId, accountId),
            eq(accountCredentials.kind, TOTP_PENDING_KIND),
          ),
        );
    }
  }

  /**
   * Activate MFA: delete the pending row, upsert the active TOTP row, and
   * set `accounts.mfa_level = 'totp'` — one transaction.
   */
  async activate(accountId: string, secretEnvelope: string, nowIso: string): Promise<void> {
    const envelope = { secret: secretEnvelope };
    // Promote: delete pending kind row, upsert active 'totp' credential.
    await this.db.root.transaction(async (tx) => {
      await tx
        .delete(accountCredentials)
        .where(
          and(
            eq(accountCredentials.accountId, accountId),
            eq(accountCredentials.kind, TOTP_PENDING_KIND),
          ),
        );
      await tx
        .insert(accountCredentials)
        .values({ accountId, kind: TOTP_KIND, envelope, verifiedAt: nowIso })
        .onConflictDoUpdate({
          // The (account, kind) unique index is PARTIAL (WHERE kind <>
          // 'webauthn') — the conflict target must carry the implying
          // predicate or inference fails.
          target: [accountCredentials.accountId, accountCredentials.kind],
          targetWhere: eq(accountCredentials.kind, TOTP_KIND),
          set: { envelope, verifiedAt: nowIso, revokedAt: null, updatedAt: nowIso },
        });
      await tx
        .update(accounts)
        .set({ mfaLevel: 'totp', updatedAt: nowIso })
        .where(eq(accounts.id, accountId));
    });
  }

  /**
   * Disable MFA: delete TOTP + pending rows, delete all unused recovery
   * codes, and reset `accounts.mfa_level = 'none'` — one transaction.
   */
  async disable(accountId: string, nowIso: string): Promise<void> {
    await this.db.root.transaction(async (tx) => {
      await tx
        .delete(accountCredentials)
        .where(
          and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, TOTP_KIND)),
        );
      await tx
        .delete(accountCredentials)
        .where(
          and(
            eq(accountCredentials.accountId, accountId),
            eq(accountCredentials.kind, TOTP_PENDING_KIND),
          ),
        );
      await tx
        .delete(accountRecoveryCodes)
        .where(
          and(
            eq(accountRecoveryCodes.accountId, accountId),
            isNull(accountRecoveryCodes.usedAt),
          ),
        );
      await tx
        .update(accounts)
        .set({ mfaLevel: 'none', updatedAt: nowIso })
        .where(eq(accounts.id, accountId));
    });
  }

  async touchLastUsed(credentialId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(accountCredentials)
      .set({ lastUsedAt: nowIso, updatedAt: nowIso })
      .where(eq(accountCredentials.id, credentialId));
  }

  /**
   * Replace the recovery-code set: delete all codes for the account and
   * insert the new (pre-hashed) ones — one transaction. Returns the
   * inserted count.
   */
  async regenerateRecoveryCodes(
    accountId: string,
    codeHashes: string[],
    // The pg schema defaults `created_at` to now() (the original service
    // never supplied it); the mongo lane stamps this value explicitly.
    _nowIso: string,
  ): Promise<number> {
    await this.db.root.transaction(async (tx) => {
      await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
      await tx
        .insert(accountRecoveryCodes)
        .values(codeHashes.map((codeHash) => ({ accountId, codeHash })));
    });
    return codeHashes.length;
  }

  /**
   * Atomic single-use recovery-code consumption. Exactly one concurrent
   * consumer wins; returns true on the win, false when the code is absent
   * or already used.
   */
  async consumeRecoveryCode(accountId: string, codeHash: string, nowIso: string): Promise<boolean> {
    const updated = await this.db.root
      .update(accountRecoveryCodes)
      .set({ usedAt: nowIso })
      .where(
        and(
          eq(accountRecoveryCodes.accountId, accountId),
          eq(accountRecoveryCodes.codeHash, codeHash),
          isNull(accountRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: accountRecoveryCodes.id });
    return updated.length === 1;
  }

  async countUnusedRecoveryCodes(accountId: string): Promise<number> {
    const rows = await this.db.root
      .select({ id: accountRecoveryCodes.id })
      .from(accountRecoveryCodes)
      .where(
        and(
          eq(accountRecoveryCodes.accountId, accountId),
          isNull(accountRecoveryCodes.usedAt),
        ),
      );
    return rows.length;
  }

  async mfaLevel(accountId: string): Promise<string> {
    const rows = await this.db.root
      .select({ mfaLevel: accounts.mfaLevel })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return rows[0]?.mfaLevel ?? 'none';
  }
}

/**
 * pg-lane row → domain. The TOTP secret envelope is the `secret` field of
 * the stored `envelope` jsonb (`{ secret: <envelope-encrypted> }`) — the
 * same field the service decrypts.
 */
function toTotpCredential(row: typeof accountCredentials.$inferSelect): TotpCredential {
  const envelope = row.envelope as { secret?: string } | null;
  return {
    id: row.id,
    kind: row.kind,
    totpSecretEnvelope: envelope?.secret ?? null,
    lastUsedAt: row.lastUsedAt,
  };
}
