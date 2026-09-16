-- eng-0061 — first-run onboarding completion + consent evidence (ledger F1-7).
--
-- Replaces the client-side freshness heuristic (`contexts.length === 1` AND
-- `accounts.created_at` within 30 minutes) with durable server state. The old
-- rule used a wall clock as a proxy for "has not onboarded yet" and provably
-- failed the users it existed to serve: the first social account in this
-- deployment reached its first successful console token exchange 75.8 minutes
-- after creation (earlier logins died mid-flow), so the window had closed,
-- /platform/welcome was never rendered — and never came back.
--
-- Gate semantics: a MISSING row means the gate is OPEN (nothing is written
-- until the account completes or explicitly skips the screen). Consent is
-- versioned, so bumping LEGAL__TERMS_VERSION re-opens the gate exactly once.
--
-- Not RLS-scoped (mirrors `accounts`): platform-plane table, the engine is the
-- only writer, and every read filters one account id explicitly with db.root.

CREATE TABLE account_onboarding (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  welcome_completed_at timestamptz,
  welcome_skipped boolean NOT NULL DEFAULT false,
  consent_version varchar(32),
  consent_accepted_at timestamptz,
  consent_source varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── PRODUCTION CUTOVER ONLY — deliberately NOT part of this migration ───────
-- Accounts that already existed when the gate shipped would otherwise each be
-- sent to /platform/welcome once. Run this per environment, DELIBERATELY, when
-- a production cutover must not disturb existing users. Leave it unrun on a
-- dev/QA corpus, where "the screen must appear at least once" is precisely the
-- behavior under test.
--
-- INSERT INTO account_onboarding (account_id, welcome_completed_at, consent_version, consent_accepted_at)
-- SELECT id, created_at, NULL, NULL FROM accounts
--   ON CONFLICT (account_id) DO NOTHING;
