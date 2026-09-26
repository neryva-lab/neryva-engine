/**
 * `IGrantCodeRepository` — the persistence port for `oauth_grants`
 * (authorization-code rows). The caller maps rows to the oidc-provider
 * payload shape (scope join, `consumed: true` marker); this port speaks
 * domain rows only.
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`.
 */
export interface GrantCodeRow {
  codeHash: string;
  clientId: string;
  accountId: string;
  redirectUri: string | null;
  scopes: string[];
  pkceChallenge: string | null;
  challengeMethod: string | null;
  nonce: string | null;
  consumedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface IGrantCodeRepository {
  upsertGrantCode(input: {
    codeHash: string;
    accountId: string;
    clientId: string;
    redirectUri: string | null;
    scopes: string[];
    pkceChallenge: string | null;
    challengeMethod: string | null;
    nonce: string | null;
    expiresAt: string;
  }): Promise<void>;
  findByCodeHash(codeHash: string): Promise<GrantCodeRow | null>;
  consumeByCodeHash(codeHash: string, nowIso: string): Promise<void>;
  destroyByCodeHash(codeHash: string): Promise<void>;
  /** Purge cascade: delete every grant of an account (account deletion). */
  deleteByAccountId(accountId: string): Promise<void>;
}
