/**
 * Shared MongoDB document shapes + row mappers for the identity-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field
 * names are the pg snake_case column names, timestamps are ISO-8601
 * strings. `_id` is left to the driver's default ObjectId (never
 * overridden); the pg primary keys live on as their own unique-indexed
 * fields (see the mongo migrator registry).
 *
 * Identity stores are platform-plane / GLOBAL — no `orgId` predicate
 * anywhere (identity tables carry no RLS by schema design).
 */
import { Binary, MongoServerError } from 'mongodb';
import type { Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { Account } from './account.repository';
import type { TotpCredential } from './mfa.repository';
import type { EmailLoginCode } from './email-code.repository';
import type { AccountActionToken } from './account-action-token.repository';
import type { OauthSession } from './session.repository';
import type { RefreshTokenRow } from './refresh-token.repository';
import type { GrantCodeRow } from './grant-code.repository';
import type { OauthClient } from './client.repository';
import type { IdentityLink } from './identity-link.repository';
import type { AccountOnboarding } from './onboarding.repository';
import type { RefreshTokenPayloadView } from './oidc-payload.repository';

/** Parse a UUID into BSON Binary subtype 4; fails closed with a validation error. */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

export function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

/** True for MongoDB duplicate-key errors. */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Rethrow a duplicate-key error as the pg unique-violation shape
 * (`code === '23505'`) so callers keep one conflict-mapping path for both
 * lanes. Non-duplicate errors propagate untouched.
 */
export function throwAsUniqueViolation(err: unknown): never {
  if (isDuplicateKey(err)) {
    const conflict = new Error('duplicate key value violates unique constraint');
    (conflict as { code?: string }).code = '23505';
    throw conflict;
  }
  throw err;
}

// ── accounts ──────────────────────────────────────────────────────────────

export interface AccountMongoDoc extends Document {
  id: Binary;
  email: string;
  display_name: string | null;
  email_verified_at: string | null;
  mfa_level: string;
  status: string;
  created_via: string;
  last_login_at: string | null;
  sessions_revoked_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toAccount(doc: WithId<AccountMongoDoc>): Account {
  return {
    id: uuidOf(doc.id),
    email: doc.email,
    displayName: doc.display_name,
    emailVerifiedAt: doc.email_verified_at,
    mfaLevel: doc.mfa_level,
    status: doc.status,
    createdVia: doc.created_via,
    lastLoginAt: doc.last_login_at,
    sessionsRevokedAt: doc.sessions_revoked_at,
    deletedAt: doc.deleted_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── account_credentials ───────────────────────────────────────────────────

export interface AccountCredentialMongoDoc extends Document {
  id: Binary;
  account_id: Binary;
  kind: string;
  secret: string | null;
  credential_id: string | null;
  envelope: { secret?: string } | null;
  verified_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toTotpCredential(doc: WithId<AccountCredentialMongoDoc>): TotpCredential {
  return {
    id: uuidOf(doc.id),
    kind: doc.kind,
    totpSecretEnvelope: doc.envelope?.secret ?? null,
    lastUsedAt: doc.last_used_at,
  };
}

// ── account_recovery_codes ────────────────────────────────────────────────

export interface AccountRecoveryCodeMongoDoc extends Document {
  id: Binary;
  account_id: Binary;
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

// ── email_login_codes ─────────────────────────────────────────────────────

export interface EmailLoginCodeMongoDoc extends Document {
  id: Binary;
  account_id: Binary;
  code_hash: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
  request_ip: string | null;
  created_at: string;
}

export function toEmailLoginCode(doc: WithId<EmailLoginCodeMongoDoc>): EmailLoginCode {
  return {
    accountId: uuidOf(doc.account_id),
    codeHash: doc.code_hash,
    expiresAt: doc.expires_at,
    attempts: doc.attempts,
    requestIp: doc.request_ip,
  };
}

// ── account_action_tokens ─────────────────────────────────────────────────

export interface AccountActionTokenMongoDoc extends Document {
  id: Binary;
  account_id: Binary;
  kind: string;
  token_hash: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  request_ip: string | null;
  created_at: string;
}

export function toAccountActionToken(doc: WithId<AccountActionTokenMongoDoc>): AccountActionToken {
  return {
    id: uuidOf(doc.id),
    accountId: uuidOf(doc.account_id),
    kind: doc.kind,
    tokenHash: doc.token_hash,
    expiresAt: doc.expires_at,
    attempts: doc.attempts,
    usedAt: doc.used_at,
  };
}

// ── oauth_sessions ────────────────────────────────────────────────────────

export interface OauthSessionMongoDoc extends Document {
  sid: string;
  account_id: Binary;
  client_id: string;
  family_id: string;
  session_uid: string | null;
  device: unknown;
  ip_country: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export function toOauthSession(doc: WithId<OauthSessionMongoDoc>): OauthSession {
  return {
    sid: doc.sid,
    accountId: uuidOf(doc.account_id),
    clientId: doc.client_id,
    familyId: doc.family_id,
    sessionUid: doc.session_uid,
    device: doc.device,
    ipCountry: doc.ip_country,
    createdAt: doc.created_at,
    lastSeenAt: doc.last_seen_at,
    revokedAt: doc.revoked_at,
  };
}

// ── oauth_refresh_tokens ──────────────────────────────────────────────────

export interface OauthRefreshTokenMongoDoc extends Document {
  jti: string;
  family_id: string;
  session_id: string | null;
  token_hash: string;
  grant_id: string | null;
  expires_at: string;
  rotated_from: string | null;
  consumed_at: string | null;
  retired_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function toRefreshTokenRow(doc: WithId<OauthRefreshTokenMongoDoc>): RefreshTokenRow {
  return {
    jti: doc.jti,
    familyId: doc.family_id,
    sessionId: doc.session_id,
    tokenHash: doc.token_hash,
    grantId: doc.grant_id,
    expiresAt: doc.expires_at,
    rotatedFrom: doc.rotated_from,
    consumedAt: doc.consumed_at,
    retiredAt: doc.retired_at,
    revokedAt: doc.revoked_at,
    createdAt: doc.created_at,
  };
}

// ── oidc_payloads ─────────────────────────────────────────────────────────

export interface OidcPayloadMongoDoc extends Document {
  model: string;
  id: string;
  payload: unknown;
  grant_id: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  created_at: string;
}

export function refreshPayloadView(payload: unknown): RefreshTokenPayloadView | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p['jti'] !== 'string' || typeof p['sessionUid'] !== 'string') {
    return undefined;
  }
  return { jti: p['jti'], sessionUid: p['sessionUid'] };
}

// ── oauth_grants ──────────────────────────────────────────────────────────

export interface OauthGrantMongoDoc extends Document {
  code_hash: string;
  account_id: Binary;
  client_id: string;
  redirect_uri: string | null;
  scopes: string[];
  pkce_challenge: string | null;
  challenge_method: string | null;
  nonce: string | null;
  consumed_at: string | null;
  expires_at: string;
  created_at: string;
}

export function toGrantCodeRow(doc: WithId<OauthGrantMongoDoc>): GrantCodeRow {
  return {
    codeHash: doc.code_hash,
    clientId: doc.client_id,
    accountId: uuidOf(doc.account_id),
    redirectUri: doc.redirect_uri,
    scopes: doc.scopes,
    pkceChallenge: doc.pkce_challenge,
    challengeMethod: doc.challenge_method,
    nonce: doc.nonce,
    consumedAt: doc.consumed_at,
    expiresAt: doc.expires_at,
    createdAt: doc.created_at,
  };
}

// ── oauth_clients ─────────────────────────────────────────────────────────

export interface OauthClientMongoDoc extends Document {
  client_id: string;
  kind: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  grant_types: string[];
  secret_envelope: string | null;
  token_ttl_seconds: number | null;
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

export function toOauthClient(doc: WithId<OauthClientMongoDoc>): OauthClient {
  return {
    clientId: doc.client_id,
    kind: doc.kind,
    name: doc.name,
    redirectUris: doc.redirect_uris,
    scopes: doc.scopes,
    grantTypes: doc.grant_types,
    secretEnvelope: doc.secret_envelope,
    tokenTtlSeconds: doc.token_ttl_seconds,
    disabled: doc.disabled,
  };
}

// ── account_onboarding ────────────────────────────────────────────────────

export interface AccountOnboardingMongoDoc extends Document {
  account_id: Binary;
  welcome_completed_at: string | null;
  welcome_skipped: boolean;
  consent_version: string | null;
  consent_accepted_at: string | null;
  consent_source: string | null;
  created_at: string;
  updated_at: string;
}

export function toAccountOnboarding(doc: WithId<AccountOnboardingMongoDoc>): AccountOnboarding {
  return {
    accountId: uuidOf(doc.account_id),
    welcomeCompletedAt: doc.welcome_completed_at,
    welcomeSkipped: doc.welcome_skipped,
    consentVersion: doc.consent_version,
    consentAcceptedAt: doc.consent_accepted_at,
    consentSource: doc.consent_source,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── account_identities ────────────────────────────────────────────────────

export interface AccountIdentityMongoDoc extends Document {
  id: Binary;
  account_id: Binary;
  provider: string;
  subject: string;
  email: string | null;
  linked_at: string;
  last_used_at: string | null;
}

export function toIdentityLink(doc: WithId<AccountIdentityMongoDoc>): IdentityLink {
  return {
    id: uuidOf(doc.id),
    accountId: uuidOf(doc.account_id),
    provider: doc.provider,
    subject: doc.subject,
    email: doc.email,
    linkedAt: doc.linked_at,
    lastUsedAt: doc.last_used_at,
  };
}
