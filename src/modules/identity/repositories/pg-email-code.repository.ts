import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { emailLoginCodes } from '../schema';
import type { EmailLoginCode, IEmailCodeRepository } from './email-code.repository';

/**
 * PostgreSQL implementation of `IEmailCodeRepository` (P3).
 *
 * Mechanical move of the `email_login_codes` units from
 * `EmailCodeService`.
 *
 * Issue semantics are preserved exactly: `issue` voids ALL previous codes
 * for the account (unconditional `consumed_at` stamp), purges dead rows
 * (consumed OR expired), then inserts the new code — three separate
 * statements, not one transaction. `findLive` is the verify read (newest
 * 20 by creation, first hash match that is unconsumed); the caller
 * applies the expiry / attempt-ceiling policy. Consumption is the atomic
 * `consume` (exactly one concurrent consumer wins). Rate limiting stays
 * in the service (Redis), not in this port.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgEmailCodeRepository implements IEmailCodeRepository {
  constructor(private readonly db: DbService) {}

  async issue(
    accountId: string,
    codeHash: string,
    requestIp: string | null,
    expiresAt: string,
    nowIso: string,
  ): Promise<void> {
    // A fresh issue voids ALL previous codes for the account, and dead
    // rows (consumed or expired) are purged so the per-account history
    // stays bounded — findLive only inspects the newest rows.
    await this.db.root
      .update(emailLoginCodes)
      .set({ consumedAt: nowIso })
      .where(eq(emailLoginCodes.accountId, accountId));

    await this.db.root
      .delete(emailLoginCodes)
      .where(
        and(
          eq(emailLoginCodes.accountId, accountId),
          or(isNotNull(emailLoginCodes.consumedAt), lt(emailLoginCodes.expiresAt, nowIso)),
        ),
      );

    await this.db.root.insert(emailLoginCodes).values({
      accountId,
      codeHash,
      requestIp,
      expiresAt,
    });
  }

  /**
   * The verify read: newest-first scan (by creation) of the account's
   * recent codes, returning the first row whose hash matches and which
   * is unconsumed — or null.
   */
  async findLive(accountId: string, codeHash: string): Promise<EmailLoginCode | null> {
    // Newest first: the live code is always at the head even for accounts
    // with a long history (an unordered LIMIT could miss it entirely).
    const rows = await this.db.root
      .select()
      .from(emailLoginCodes)
      .where(eq(emailLoginCodes.accountId, accountId))
      .orderBy(desc(emailLoginCodes.createdAt))
      .limit(20);
    const row = rows.find((r) => r.codeHash === codeHash && !r.consumedAt);
    return row ? toEmailLoginCode(row) : null;
  }

  /** Atomically consume a verified code; false when raced/consumed. */
  async consume(accountId: string, codeHash: string): Promise<boolean> {
    const result = await this.db.root
      .update(emailLoginCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(
        and(
          eq(emailLoginCodes.codeHash, codeHash),
          eq(emailLoginCodes.accountId, accountId),
          isNull(emailLoginCodes.consumedAt),
        ),
      )
      .returning({ id: emailLoginCodes.id });
    return result.length === 1;
  }

  /** Increment the attempt counter on the account's unconsumed code rows. */
  async registerFailedAttempt(accountId: string): Promise<void> {
    await this.db.root
      .update(emailLoginCodes)
      .set({ attempts: sql`${emailLoginCodes.attempts} + 1` })
      .where(and(eq(emailLoginCodes.accountId, accountId), isNull(emailLoginCodes.consumedAt)));
  }
}

function toEmailLoginCode(row: typeof emailLoginCodes.$inferSelect): EmailLoginCode {
  return {
    accountId: row.accountId,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    requestIp: row.requestIp,
  };
}
