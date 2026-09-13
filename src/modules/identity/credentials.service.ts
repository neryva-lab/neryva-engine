import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { accountCredentials } from './schema';

/**
 * argon2id credentials (doc-06 §10.1): m=64 MiB, t=3, p=1 — the floor the
 * design pins; tune upward at deploy, never downward. Rehash-on-login keeps
 * hashes current when parameters change without forcing resets.
 *
 * AUTH-3.2 (auth_plan.md D4): the password factor lives in
 * account_credentials kind='password' — the single factor registry. The
 * denormalized accounts.password_hash column was dropped (drizzle/0047);
 * this service is the ONLY reader/writer of password material.
 */
const ARGON2_OPTS = {
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

const PASSWORD_KIND = 'password';

@Injectable()
export class CredentialsService {
  constructor(private readonly db: DbService) {}

  async hashPassword(password: string): Promise<string> {
    this.assertAcceptablePassword(password);
    return hash(password, { ...ARGON2_OPTS });
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // Malformed stored hash — fail closed.
      return false;
    }
  }

  /** True when the stored hash's parameters are weaker than the current floor. */
  needsRehash(passwordHash: string): boolean {
    // @node-rs/argon2 encodes params in the PHC string; parse m= and t=.
    const m = /m=(\d+)/.exec(passwordHash)?.[1];
    const t = /t=(\d+)/.exec(passwordHash)?.[1];
    if (!m || !t) {
      return true; // non-PHC hash — rehash
    }
    return Number.parseInt(m, 10) < ARGON2_OPTS.memoryCost || Number.parseInt(t, 10) < ARGON2_OPTS.timeCost;
  }

  /**
   * The account's password hash, or null when the account is passwordless
   * (no kind='password' row — the account-registry notion of "no password").
   */
  async getPasswordHash(accountId: string): Promise<string | null> {
    const rows = await this.db.root
      .select({ secret: accountCredentials.secret })
      .from(accountCredentials)
      .where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, PASSWORD_KIND), isNull(accountCredentials.revokedAt)))
      .limit(1);
    return rows[0]?.secret ?? null;
  }

  /** Upsert the password factor row (insert or rotate the secret in place). */
  async setPasswordHash(accountId: string, passwordHash: string): Promise<void> {
    await this.db.root
      .insert(accountCredentials)
      .values({ accountId, kind: PASSWORD_KIND, secret: passwordHash })
      .onConflictDoUpdate({
        target: [accountCredentials.accountId, accountCredentials.kind],
        targetWhere: eq(accountCredentials.kind, PASSWORD_KIND),
        set: { secret: passwordHash, updatedAt: new Date().toISOString() },
      });
  }

  private assertAcceptablePassword(password: string): void {
    if (password.length < 12 || password.length > 512) {
      throw new Error('password must be between 12 and 512 characters');
    }
  }
}
