import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Identity schema — doc-06 §11, engine-owned from creation (eng-0001).
 * Platform-plane tables: NOT tenant-scoped, no RLS (accounts are the
 * company's credential store; the engine is the only writer).
 *
 * citext keeps email uniqueness case-insensitive exactly like the Python
 * side's citext columns (migration creates the extension).
 */
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'string' }),
  passwordHash: text('password_hash'), // NULL ⇒ passwordless-only account
  displayName: varchar('display_name', { length: 256 }),
  status: varchar('status', { length: 32 }).notNull().default('active'), // active | locked | disabled
  mfaLevel: varchar('mfa_level', { length: 16 }).notNull().default('none'), // none | totp | webauthn
  /**
   * How the account came to exist: email_code (the passwordless default) or
   * social:{provider}. Backs the one-way binding rule (doc-06 Δ1): a
   * federated-origin account never grows a password.
   */
  createdVia: varchar('created_via', { length: 32 }).notNull().default('email_code'),
  /** Global session kill-switch: sessions issued before this instant are dead. */
  sessionsRevokedAt: timestamp('sessions_revoked_at', { withTimezone: true, mode: 'string' }),
  /** Staged self-service deletion (H-6): the grace-window deadline; NULL = live. */
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_accounts_email').on(t.email)]);

export const accountCredentials = pgTable('account_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 32 }).notNull(), // password | email_code | totp | webauthn
  /** argon2id hash (password), TOTP secret envelope, or webauthn enrollment JSON. */
  secret: text('secret'),
  envelope: jsonb('envelope'),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_account_credentials_account_kind').on(t.accountId, t.kind)]);

export const accountRecoveryCodes = pgTable('account_recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_recovery_codes_account').on(t.accountId)]);

/** Federated identities AND website links live here (doc-06 D7/D8). */
export const accountIdentities = pgTable('account_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 32 }).notNull(), // local | oidc | saml | website
  subject: varchar('subject', { length: 255 }).notNull(),
  email: citext('email'),
  linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
}, (t) => [uniqueIndex('uq_account_identities_provider_subject').on(t.provider, t.subject)]);

/**
 * The first-party-only client registry: a table we INSERT into, never an
 * API the world registers against (doc-06 D2). Every surface — console,
 * website, satellites — is a row here.
 */
export const oauthClients = pgTable('oauth_clients', {
  clientId: varchar('client_id', { length: 64 }).primaryKey(),
  kind: varchar('kind', { length: 16 }).notNull(), // public | confidential | service
  name: varchar('name', { length: 128 }).notNull(),
  ownerOrg: varchar('owner_org', { length: 36 }),
  redirectUris: jsonb('redirect_uris').notNull().default(sql`'[]'::jsonb`),
  scopes: jsonb('scopes').notNull().default(sql`'[]'::jsonb`),
  grantTypes: jsonb('grant_types').notNull().default(sql`'[]'::jsonb`),
  /** Confidential/service: envelope-encrypted client secret (enc:v1:...). */
  secretEnvelope: text('secret_envelope'),
  tokenTtlSeconds: integer('token_ttl_seconds'),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/** L1 session registry: the device list / "sign out everywhere" surface. */
export const oauthSessions = pgTable('oauth_sessions', {
  sid: varchar('sid', { length: 128 }).primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  familyId: uuid('family_id').notNull(),
  device: jsonb('device').notNull().default(sql`'{}'::jsonb`),
  ipCountry: varchar('ip_country', { length: 8 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
}, (t) => [index('ix_oauth_sessions_account').on(t.accountId)]);

/** Refresh tokens: rotation lineage + reuse tripwire (family revocation). */
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  jti: varchar('jti', { length: 128 }).primaryKey(),
  familyId: uuid('family_id').notNull(),
  sessionId: varchar('session_id', { length: 128 }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  grantId: varchar('grant_id', { length: 128 }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  rotatedFrom: varchar('rotated_from', { length: 128 }),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_refresh_tokens_family').on(t.familyId)]);

/** Authorization codes: 60-second single-use PKCE-carrying grants. */
export const oauthGrants = pgTable('oauth_grants', {
  codeHash: varchar('code_hash', { length: 64 }).primaryKey(),
  clientId: varchar('client_id', { length: 64 }).notNull(),
  accountId: uuid('account_id').notNull(),
  redirectUri: text('redirect_uri'),
  scopes: jsonb('scopes').notNull().default(sql`'[]'::jsonb`),
  pkceChallenge: text('pkce_challenge'),
  challengeMethod: varchar('challenge_method', { length: 16 }),
  nonce: text('nonce'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * Generic oidc-provider payload storage for the models that have no
 * dedicated table (Session, Grant, AccessToken introspection records,
 * LoginHint...). Engine-owned; the adapter dispatches by model name.
 */
export const oidcPayloads = pgTable(
  'oidc_payloads',
  {
    model: varchar('model', { length: 32 }).notNull(),
    id: varchar('id', { length: 128 }).notNull(),
    payload: jsonb('payload').notNull(),
    grantId: varchar('grant_id', { length: 128 }),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.model, t.id] })],
);

/** Email one-time codes (Δ1 primary login). Hashed, single-use, attempt-capped. */
export const emailLoginCodes = pgTable('email_login_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  requestIp: varchar('request_ip', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_email_codes_account').on(t.accountId)]);

/**
 * Account action tokens (eng-0010): single-use hashed tokens for emailed
 * account-lifecycle actions — email verification and password reset. Same
 * discipline as login codes: sha256 at rest, TTL-capped, attempt-capped,
 * and a fresh issue voids previous tokens of the same kind for the account.
 */
export const accountActionTokens = pgTable('account_action_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** email_verify | password_reset */
  kind: varchar('kind', { length: 32 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
  requestIp: varchar('request_ip', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_account_action_tokens_hash').on(t.tokenHash),
  index('ix_account_action_tokens_account_kind').on(t.accountId, t.kind),
]);
