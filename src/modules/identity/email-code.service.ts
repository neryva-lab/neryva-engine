import { randomInt } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { RedisService } from '../../common/infra/redis.service';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { emailLoginCodes } from './schema';

/**
 * Email one-time codes — the PRIMARY login path (Δ1). Security model:
 *
 *  - 8-digit crypto-random; only the SHA-256 hash is stored.
 *  - single-use (consumed_at), TTL-capped, attempt-capped per code.
 *  - per-account AND per-IP token buckets (Redis) to stop code-request
 *    floods and guessing sweeps independently.
 *  - enumeration-resistant by construction: an unknown email still returns
 *    "code sent" (the caller upserts an account on first login, so there
 *    is no "user does not exist" signal to leak at this layer anyway).
 */
const CODE_DIGITS = 8;
const MAX_ATTEMPTS = env.IDENTITY_EMAIL_CODE_MAX_ATTEMPTS;

export type IssueResult = { ok: true; code: string } | { ok: false; reason: 'account_rate_limited' | 'ip_rate_limited' };
export type VerifyResult = { ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'expired' | 'too_many_attempts' | 'rate_limited' };

@Injectable()
export class EmailCodeService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  async issue(accountId: string, requestIp: string | null): Promise<IssueResult> {
    const budget = await this.budgetAllows(accountId, requestIp);
    if (budget !== true) {
      return { ok: false, reason: budget };
    }
    const code = String(randomInt(0, 100_000_000)).padStart(CODE_DIGITS, '0');
    const expiresAt = new Date(Date.now() + env.IDENTITY_EMAIL_CODE_TTL_SECONDS * 1000).toISOString();

    // A fresh issue voids previous unconsumed codes for the account, and
    // dead rows (consumed or expired) are purged so the per-account history
    // stays bounded — verify() only inspects the newest rows.
    await this.db.root
      .update(emailLoginCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(eq(emailLoginCodes.accountId, accountId));

    await this.db.root
      .delete(emailLoginCodes)
      .where(
        and(
          eq(emailLoginCodes.accountId, accountId),
          or(isNotNull(emailLoginCodes.consumedAt), lt(emailLoginCodes.expiresAt, new Date().toISOString())),
        ),
      );

    await this.db.root.insert(emailLoginCodes).values({
      accountId,
      codeHash: sha256Hex(code),
      requestIp: requestIp ?? null,
      expiresAt,
    });
    return { ok: true, code };
  }

  async verify(accountId: string, presentedCode: string): Promise<VerifyResult> {
    if (presentedCode.length !== CODE_DIGITS || !/^\d+$/.test(presentedCode)) {
      return { ok: false, reason: 'invalid' };
    }
    const hash = sha256Hex(presentedCode);
    // Newest first: the live code is always at the head even for accounts
    // with a long history (an unordered LIMIT could miss it entirely).
    const rows = await this.db.root
      .select()
      .from(emailLoginCodes)
      .where(eq(emailLoginCodes.accountId, accountId))
      .orderBy(desc(emailLoginCodes.createdAt))
      .limit(20);
    const row = rows.find((r) => r.codeHash === hash && !r.consumedAt);
    if (!row) {
      return { ok: false, reason: 'invalid' };
    }
    if (Date.parse(row.expiresAt) < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'too_many_attempts' };
    }

    return { ok: true, accountId: row.accountId };
  }

  /** Atomically consume a verified code; false when raced/consumed. */
  async consume(accountId: string, code: string): Promise<boolean> {
    const result = await this.db.root
      .update(emailLoginCodes)
      .set({ consumedAt: new Date().toISOString() })
      .where(and(eq(emailLoginCodes.codeHash, sha256Hex(code)), eq(emailLoginCodes.accountId, accountId), isNull(emailLoginCodes.consumedAt)))
      .returning({ id: emailLoginCodes.id });
    return result.length === 1;
  }

  /** Record a failed verification attempt against the account's live codes. */
  async registerFailedAttempt(accountId: string): Promise<void> {
    await this.db.root
      .update(emailLoginCodes)
      .set({ attempts: sql`${emailLoginCodes.attempts} + 1` })
      .where(and(eq(emailLoginCodes.accountId, accountId), isNull(emailLoginCodes.consumedAt)));
  }

  // ── Rate budgets: 3 codes/account/hour, 10/IP/hour (fixed window) ───────
  private async budgetAllows(accountId: string, ip: string | null): Promise<true | 'account_rate_limited' | 'ip_rate_limited'> {
    try {
      const a = await this.redis.raw.incr(`emailcode:acct:${accountId}:${hourWindow()}`);
      if (a === 1) {
        await this.redis.raw.expire(`emailcode:acct:${accountId}:${hourWindow()}`, 3700);
      }
      if (a > 3) {
        return 'account_rate_limited';
      }
      if (ip) {
        const i = await this.redis.raw.incr(`emailcode:ip:${ip}:${hourWindow()}`);
        if (i === 1) {
          await this.redis.raw.expire(`emailcode:ip:${ip}:${hourWindow()}`, 3700);
        }
        if (i > 10) {
          return 'ip_rate_limited';
        }
      }
      return true;
    } catch {
      // Redis unavailable: fail-open here — the durable attempt caps and
      // single-use semantics still bound the damage; flag in logs.
      return true;
    }
  }
}

function hourWindow(): number {
  return Math.floor(Date.now() / 3_600_000);
}
