import { hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

/**
 * argon2id credentials (doc-06 §10.1): m=64 MiB, t=3, p=1 — the floor the
 * design pins; tune upward at deploy, never downward. Rehash-on-login keeps
 * hashes current when parameters change without forcing resets.
 */
const ARGON2_OPTS = {
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

@Injectable()
export class CredentialsService {
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

  private assertAcceptablePassword(password: string): void {
    if (password.length < 12 || password.length > 512) {
      throw new Error('password must be between 12 and 512 characters');
    }
  }
}
