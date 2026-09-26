/**
 * DI tokens for the identity-module persistence ports (P3).
 *
 * Every identity store is platform-plane / global: the identity schema is
 * explicitly NOT tenant-scoped (see `src/modules/identity/schema.ts` —
 * "identity tables are NOT tenant-scoped and carry no RLS"). Repository
 * methods are therefore keyed by `accountId`, never by `orgId`; the one
 * cross-tenant operation (account purge) is a documented administrative
 * port method, not an ambient bypass.
 *
 * Services inject these tokens only — never Drizzle, never MongoDB, never
 * `DbService` / `MongoDbService`. Provider selection happens once, in
 * `identity.module.ts`, via `DB_PROVIDER`.
 */
export const ACCOUNT_REPOSITORY = Symbol('IAccountRepository');
export const CREDENTIAL_REPOSITORY = Symbol('ICredentialRepository');
export const MFA_REPOSITORY = Symbol('IMfaRepository');
export const EMAIL_CODE_REPOSITORY = Symbol('IEmailCodeRepository');
export const ACCOUNT_ACTION_TOKEN_REPOSITORY = Symbol('IAccountActionTokenRepository');
export const SESSION_REPOSITORY = Symbol('ISessionRepository');
export const REFRESH_TOKEN_REPOSITORY = Symbol('IRefreshTokenRepository');
export const OIDC_PAYLOAD_REPOSITORY = Symbol('IOidcPayloadRepository');
export const GRANT_CODE_REPOSITORY = Symbol('IGrantCodeRepository');
export const OAUTH_CLIENT_REPOSITORY = Symbol('IOauthClientRepository');
export const ONBOARDING_REPOSITORY = Symbol('IOnboardingRepository');
export const IDENTITY_LINK_REPOSITORY = Symbol('IIdentityLinkRepository');
