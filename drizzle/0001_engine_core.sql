-- eng-0001: identity core + email deliveries (engine-owned from creation).
-- Statement-level idempotence is NOT used: drizzle migrations run exactly
-- once per database, tracked by the journal.

CREATE EXTENSION IF NOT EXISTS citext;

-- ── accounts (platform-plane: no RLS — the engine is the only writer) ─────
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  email_verified_at timestamptz,
  password_hash text,
  display_name varchar(256),
  status varchar(32) NOT NULL DEFAULT 'active',
  mfa_level varchar(16) NOT NULL DEFAULT 'none',
  sessions_revoked_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_accounts_email ON accounts (email);

CREATE TABLE account_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  secret text,
  envelope jsonb,
  verified_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_account_credentials_account_kind ON account_credentials (account_id, kind);

CREATE TABLE account_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  code_hash varchar(64) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_recovery_codes_account ON account_recovery_codes (account_id);

CREATE TABLE account_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider varchar(32) NOT NULL,
  subject varchar(255) NOT NULL,
  email citext,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE UNIQUE INDEX uq_account_identities_provider_subject ON account_identities (provider, subject);

-- ── the client registry (rows we INSERT into — never a public API) ───────
CREATE TABLE oauth_clients (
  client_id varchar(64) PRIMARY KEY,
  kind varchar(16) NOT NULL,
  name varchar(128) NOT NULL,
  owner_org varchar(36),
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  grant_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  secret_envelope text,
  token_ttl_seconds integer,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── L1 session registry (the device list / sign-out-everywhere surface) ──
CREATE TABLE oauth_sessions (
  sid varchar(128) PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  client_id varchar(64) NOT NULL,
  family_id uuid NOT NULL,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_country varchar(8),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ix_oauth_sessions_account ON oauth_sessions (account_id);

CREATE TABLE oauth_refresh_tokens (
  jti varchar(128) PRIMARY KEY,
  family_id uuid NOT NULL,
  session_id varchar(128),
  token_hash varchar(64) NOT NULL,
  grant_id varchar(128),
  expires_at timestamptz NOT NULL,
  rotated_from varchar(128),
  consumed_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_family ON oauth_refresh_tokens (family_id);

CREATE TABLE oauth_grants (
  code_hash varchar(64) PRIMARY KEY,
  client_id varchar(64) NOT NULL,
  account_id uuid NOT NULL,
  redirect_uri text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  pkce_challenge text,
  challenge_method varchar(16),
  nonce text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oidc_payloads (
  model varchar(32) NOT NULL,
  id varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  grant_id varchar(128),
  consumed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, id)
);

CREATE TABLE email_login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  code_hash varchar(64) NOT NULL,
  request_ip varchar(64),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_codes_account ON email_login_codes (account_id);

-- ── email delivery audit (corporate E-1) ──────────────────────────────────
CREATE TABLE email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template varchar(64) NOT NULL,
  recipient varchar(320) NOT NULL,
  subject text NOT NULL,
  transport varchar(32) NOT NULL,
  status varchar(16) NOT NULL,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_deliveries_recipient_created ON email_deliveries (recipient, created_at);
