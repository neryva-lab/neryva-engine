-- eng-0010: identity lifecycle (the audit's I-1/I-2 blockers): single-use
-- hashed action tokens for emailed account actions (password reset, email
-- verification). Same discipline as email_login_codes: sha256 at rest,
-- TTL-capped, attempt-capped; fresh issue voids the previous token.

CREATE TABLE account_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,                -- email_verify | password_reset
  token_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  request_ip varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_account_action_tokens_hash ON account_action_tokens (token_hash);
CREATE INDEX ix_account_action_tokens_account_kind ON account_action_tokens (account_id, kind);
