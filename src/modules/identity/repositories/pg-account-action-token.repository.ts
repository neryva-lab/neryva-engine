import { and, eq, isNull, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accountActionTokens } from '../schema';
import type { AccountActionToken, IAccountActionTokenRepository } from './account-action-token.repository';

/**
 * PostgreSQL implementation of `IAccountActionTokenRepository` (P3).
 *
 * Mechanical move of the `account_action_tokens` units from
 * `AccountActionsService` (the email-change / account-deletion token
 * lifecycle).
 *
 * Like email codes, `issue` voids the previous unconsumed token of the
 * same kind and inserts the new one as separate statements. `peek` is the
 * verify-without-consuming read (unconsumed row or null); the caller
 * applies the expiry / attempt-ceiling policy. `consume` is the atomic
 * single-use compare-and-set — exactly one concurrent consumer wins.
 * The Redis issue-cooldown stays in the service.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgAccountActionTokenRepository implements IAccountActionTokenRepository {
  constructor(private readonly db: DbService) {}

  async issue(
    accountId: string,
    kind: string,
    tokenHash: string,
    requestIp: string | null,
    expiresAt: string,
  ): Promise<void> {
    // Void previous unconsumed tokens of this kind for the account.
    await this.db.root
      .update(accountActionTokens)
      .set({ usedAt: new Date().toISOString() })
      .where(
        and(
          eq(accountActionTokens.accountId, accountId),
          eq(accountActionTokens.kind, kind),
          isNull(accountActionTokens.usedAt),
        ),
      );

    await this.db.root.insert(accountActionTokens).values({
      accountId,
      kind,
      tokenHash,
      expiresAt,
      requestIp,
    });
  }

  /** The live (unconsumed) row for a token hash + kind, or null. */
  async peek(tokenHash: string, kind: string): Promise<AccountActionToken | null> {
    const rows = await this.db.root
      .select()
      .from(accountActionTokens)
      .where(
        and(eq(accountActionTokens.tokenHash, tokenHash), eq(accountActionTokens.kind, kind)),
      )
      .limit(1);
    const row = rows[0];
    return row && !row.usedAt ? toAccountActionToken(row) : null;
  }

  /**
   * Atomic single-use consumption by row id: stamp the row only when it is
   * still unconsumed — exactly one concurrent consumer wins. Mirrors the
   * original service statement (`WHERE id = row.id AND used_at IS NULL`).
   */
  async consume(id: string, nowIso: string): Promise<AccountActionToken | null> {
    const updated = await this.db.root
      .update(accountActionTokens)
      .set({ usedAt: nowIso })
      .where(and(eq(accountActionTokens.id, id), isNull(accountActionTokens.usedAt)))
      .returning();
    return updated[0] ? toAccountActionToken(updated[0]) : null;
  }

  /** Record a failed presentation against the live token row. */
  async registerFailedAttempt(tokenHash: string, kind: string): Promise<void> {
    await this.db.root
      .update(accountActionTokens)
      .set({ attempts: sql`${accountActionTokens.attempts} + 1` })
      .where(
        and(
          eq(accountActionTokens.tokenHash, tokenHash),
          eq(accountActionTokens.kind, kind),
          isNull(accountActionTokens.usedAt),
        ),
      );
  }
}

function toAccountActionToken(row: typeof accountActionTokens.$inferSelect): AccountActionToken {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    usedAt: row.usedAt,
  };
}
