import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { oauthGrants } from '../schema';
import type { GrantCodeRow, IGrantCodeRepository } from './grant-code.repository';

/**
 * PostgreSQL implementation of `IGrantCodeRepository` (P3).
 *
 * Mechanical move of the `oauth_grants` (authorization-code) units from
 * `OidcDrizzleAdapter`. The caller maps rows to the oidc-provider payload
 * shape (scope join, `consumed: true` marker); this port speaks domain rows
 * only.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgGrantCodeRepository implements IGrantCodeRepository {
  constructor(private readonly db: DbService) {}

  /** Plain insert — no conflict handling, exactly like the adapter. */
  async upsertGrantCode(input: {
    codeHash: string;
    accountId: string;
    clientId: string;
    redirectUri: string | null;
    scopes: string[];
    pkceChallenge: string | null;
    challengeMethod: string | null;
    nonce: string | null;
    expiresAt: string;
  }): Promise<void> {
    await this.db.root.insert(oauthGrants).values({
      codeHash: input.codeHash,
      clientId: input.clientId,
      accountId: input.accountId,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      pkceChallenge: input.pkceChallenge,
      challengeMethod: input.challengeMethod,
      nonce: input.nonce,
      expiresAt: input.expiresAt,
    });
  }

  async findByCodeHash(codeHash: string): Promise<GrantCodeRow | null> {
    const rows = await this.db.root
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.codeHash, codeHash))
      .limit(1);
    return rows[0] ? toGrantCodeRow(rows[0]) : null;
  }

  async consumeByCodeHash(codeHash: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(oauthGrants)
      .set({ consumedAt: nowIso })
      .where(eq(oauthGrants.codeHash, codeHash));
  }

  async destroyByCodeHash(codeHash: string): Promise<void> {
    await this.db.root.delete(oauthGrants).where(eq(oauthGrants.codeHash, codeHash));
  }

  /** Purge cascade: delete every grant of an account (account deletion). */
  async deleteByAccountId(accountId: string): Promise<void> {
    await this.db.root.delete(oauthGrants).where(eq(oauthGrants.accountId, accountId));
  }
}

function toGrantCodeRow(row: typeof oauthGrants.$inferSelect): GrantCodeRow {
  return {
    codeHash: row.codeHash,
    clientId: row.clientId,
    accountId: row.accountId,
    redirectUri: row.redirectUri,
    scopes: stringArray(row.scopes),
    pkceChallenge: row.pkceChallenge,
    challengeMethod: row.challengeMethod,
    nonce: row.nonce,
    consumedAt: row.consumedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** jsonb array columns arrive as `unknown` — coerce defensively. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}
