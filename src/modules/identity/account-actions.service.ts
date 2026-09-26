import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../../common/infra/redis.service';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { ACCOUNT_ACTION_TOKEN_REPOSITORY } from './repositories/repository-tokens';
import type { IAccountActionTokenRepository } from './repositories/account-action-token.repository';

/**
 * Single-use hashed action tokens for emailed account-lifecycle steps
 * (email verification, password reset) — the same discipline as login
 * codes: sha256 at rest, TTL-capped, attempt-capped (3), and a fresh issue
 * voids the account's previous tokens of the same kind. Tokens are 32
 * random bytes, base64url-encoded — 256 bits of entropy, URL-safe.
 *
 * Enumeration resistance: `issue` for an unknown account returns a token
 * that is never emailed (the caller checks existence first and ALWAYS
 * behaves identically to the caller); `consume` failure modes are uniform.
 * A per-account cooldown (60s) stops token-flood emails.
 *
 * Persistence goes through `IAccountActionTokenRepository`
 * (provider-blind); the expiry / attempt-ceiling policy stays here.
 */
export type ActionKind = 'email_verify' | 'password_reset';

const TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes
const MAX_ATTEMPTS = 3;
const ISSUE_COOLDOWN_SECONDS = 60;

export type ConsumeResult = { ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'expired' | 'too_many_attempts' };

@Injectable()
export class AccountActionsService {
  constructor(
    @Inject(ACCOUNT_ACTION_TOKEN_REPOSITORY) private readonly tokens: IAccountActionTokenRepository,
    private readonly redis: RedisService,
  ) {}

  async issue(accountId: string, kind: ActionKind, requestIp: string | null): Promise<{ ok: true; token: string } | { ok: false; reason: 'cooldown' }> {
    // Cooldown bucket: the account gets at most one email per minute per kind.
    try {
      const bucket = await this.redis.raw.incr(`actiontok:${kind}:${accountId}:${minuteWindow()}`);
      if (bucket === 1) {
        await this.redis.raw.expire(`actiontok:${kind}:${accountId}:${minuteWindow()}`, ISSUE_COOLDOWN_SECONDS + 5);
      }
      if (bucket > 1) {
        return { ok: false, reason: 'cooldown' };
      }
    } catch {
      // Redis unavailable: proceed — the per-account attempt caps below still
      // bound abuse; the cooldown is a mail-flood guard, not a security bound.
    }

    const token = randomBytes(32).toString('base64url');
    // Void previous unconsumed tokens of this kind for the account, then
    // insert the new one — separate statements, not one transaction.
    await this.tokens.issue(
      accountId,
      kind,
      sha256Hex(token),
      requestIp ?? null,
      new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    );
    return { ok: true, token };
  }

  /** Verify without consuming (to distinguish expiry from invalid before burning). */
  async peek(token: string, kind: ActionKind): Promise<ConsumeResult> {
    const row = await this.findLive(token, kind);
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

  /** Atomically consume a verified token; false when raced/used. */
  async consume(token: string, kind: ActionKind): Promise<{ ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'too_many_attempts' }> {
    const row = await this.findLive(token, kind);
    if (!row) {
      return { ok: false, reason: 'invalid' };
    }
    // Atomic single-use compare-and-set by the previously read row id —
    // exactly one concurrent consumer wins the race.
    const consumed = await this.tokens.consume(row.id, new Date().toISOString());
    if (!consumed) {
      return { ok: false, reason: 'invalid' }; // lost the single-use race
    }
    return { ok: true, accountId: consumed.accountId };
  }

  /** Record a failed presentation against the live token row. */
  async registerFailedAttempt(token: string, kind: ActionKind): Promise<void> {
    await this.tokens.registerFailedAttempt(sha256Hex(token), kind);
  }

  private findLive(token: string, kind: ActionKind) {
    if (token.length < 16 || token.length > 128) {
      return Promise.resolve(null);
    }
    return this.tokens.peek(sha256Hex(token), kind);
  }
}

function minuteWindow(): number {
  return Math.floor(Date.now() / 60_000);
}
