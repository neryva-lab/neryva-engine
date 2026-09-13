-- 0046 — AUTH-3.1 (auth_ledger.md / auth_plan.md D4, expand step): factor
-- registry becomes the single home for every authentication factor.
--
-- Shape rationale (auth_plan.md D4): a composite UNIQUE(account_id, kind,
-- credential_id) would lose password uniqueness to NULL-distinctness (NULLs
-- are distinct by default; fixing that needs PG15+ NULLS NOT DISTINCT), so the
-- invariants are expressed as two partial unique indexes instead — valid on
-- every supported PostgreSQL version:
--   1. at most one row per (account, kind) for every non-WebAuthn kind
--      (password / email_code / totp — one password per account);
--   2. at most one credential row per passkey credential_id, but MANY WebAuthn
--      rows per account (multiple passkeys is the point of the factor registry).
--
-- Backfill: existing password hashes move from accounts.password_hash into
-- kind='password' rows. Provenance (lastVerified) is unknowable for historical
-- rows and left NULL — the column records the last successful proof going
-- forward. Idempotent: rows that already exist are left untouched.

ALTER TABLE "account_credentials" ADD COLUMN "credential_id" varchar(255);

DROP INDEX IF EXISTS "uq_account_credentials_account_kind";
CREATE UNIQUE INDEX "uq_account_credentials_account_kind"
  ON "account_credentials" ("account_id", "kind")
  WHERE "kind" <> 'webauthn';
CREATE UNIQUE INDEX "uq_account_credentials_credential_id"
  ON "account_credentials" ("credential_id")
  WHERE "credential_id" IS NOT NULL;

INSERT INTO "account_credentials" ("id", "account_id", "kind", "secret", "created_at", "updated_at")
SELECT gen_random_uuid(), a."id", 'password', a."password_hash", now(), now()
FROM "accounts" a
WHERE a."password_hash" IS NOT NULL
ON CONFLICT DO NOTHING;
