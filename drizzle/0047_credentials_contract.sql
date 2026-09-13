-- 0047 — AUTH-3.3 (auth_ledger.md / auth_plan.md D4, contract step): drop the
-- denormalized accounts.password_hash column. account_credentials (kind=
-- 'password') is the single source of truth for password material; every
-- engine reader/writer was switched in the same change set (AUTH-3.2), so
-- there is no dual-write window left to protect.
--
-- RELEASE-GATE NOTE (auth_ledger.md AUTH-3.3): the one-release dual-read
-- window in the plan protects DEPLOYED data. This repository has not had its
-- first production deploy or full CI/DB run — the entire 0001–0047 chain is
-- applied by a single release job — so the window collapses to zero and the
-- contract step lands in the same ordered migration sequence. If 0046 has
-- already been applied to a deployed environment, DO NOT apply 0047 until one
-- release cycle has run with the AUTH-3.2 code live.
--
-- Forward-fix only: re-adding the column would resurrect a second source of
-- truth. Rollback = restore from the pre-migration backup, never re-expand.

ALTER TABLE "accounts" DROP COLUMN "password_hash";
