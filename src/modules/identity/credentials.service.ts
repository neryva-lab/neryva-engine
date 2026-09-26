import { hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import { CREDENTIAL_REPOSITORY } from './repositories/repository-tokens';
import type { ICredentialRepository } from './repositories/credential.repository';

/**
 * argon2id credentials (doc-06 §10.1): m=64 MiB, t=3, p=1 — the floor the
 * design pins; tune upward at deploy, never downward. Rehash-on-login keeps
 * hashes current when parameters change without forcing resets.
 *
 * AUTH-3.2 (auth_plan.md D4): the password factor lives in
 * account_credentials kind='password' — the single factor registry. The
 * denormalized accounts.password_hash column was dropped (drizzle/0047);
 * this service is the ONLY reader/writer of password material.
 *
 * Persistence goes through `ICredentialRepository` (provider-blind); all
 * crypto and password policy stays here.
 */
const ARGON2_OPTS = {
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

@Injectable()
export class CredentialsService {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: ICredentialRepository,
  ) {}

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
    return this.credentials.getPasswordHash(accountId);
  }

  /** Upsert the password factor row (insert or rotate the secret in place). */
  async setPasswordHash(accountId: string, passwordHash: string): Promise<void> {
    await this.credentials.setPasswordHash(accountId, passwordHash);
  }

  private assertAcceptablePassword(password: string): void {
    if (password.length < 12 || password.length > 512) {
      throw new Error('password must be between 12 and 512 characters');
    }
  }
}
