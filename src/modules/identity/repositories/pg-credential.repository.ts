import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accountCredentials } from '../schema';
import type { ICredentialRepository } from './credential.repository';

const PASSWORD_KIND = 'password';

/**
 * PostgreSQL implementation of `ICredentialRepository` (P3).
 *
 * Mechanical move of the password-factor units from `CredentialsService`:
 * `getPasswordHash` reads the `kind = 'password'` row (AUTH-3.2 — password
 * presence comes from the factor registry, not the account row);
 * `setPasswordHash` inserts or rotates the secret in place.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgCredentialRepository implements ICredentialRepository {
  constructor(private readonly db: DbService) {}

  /** The stored argon2 hash for the password factor, or null when absent. */
  async getPasswordHash(accountId: string): Promise<string | null> {
    const rows = await this.db.root
      .select({ secret: accountCredentials.secret })
      .from(accountCredentials)
      .where(
        and(
          eq(accountCredentials.accountId, accountId),
          eq(accountCredentials.kind, PASSWORD_KIND),
          isNull(accountCredentials.revokedAt),
        ),
      )
      .limit(1);
    return rows[0]?.secret ?? null;
  }

  /** Upsert the password factor row (insert or rotate the secret in place). */
  async setPasswordHash(accountId: string, passwordHash: string): Promise<void> {
    await this.db.root
      .insert(accountCredentials)
      .values({ accountId, kind: PASSWORD_KIND, secret: passwordHash })
      .onConflictDoUpdate({
        // The (account, kind) unique index is PARTIAL (WHERE kind <>
        // 'webauthn') — the conflict target must carry the implying
        // predicate or inference fails.
        target: [accountCredentials.accountId, accountCredentials.kind],
        targetWhere: eq(accountCredentials.kind, PASSWORD_KIND),
        set: { secret: passwordHash, updatedAt: new Date().toISOString() },
      });
  }
}
