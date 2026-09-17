-- 0062 — Operate fix (team_setup_ledger.md live verification).
--
-- assistant_rollouts.id was created WITHOUT a default (0042), while every
-- writer (RolloutsService.set / setRelease) relies on the DB to generate it
-- — every rollout/release write 500d. Sibling identity tables
-- (assistants, assistant_versions) default gen_random_uuid(); this aligns
-- the rollouts table with them. No backfill needed (no row can exist
-- without an id — the column is PRIMARY KEY NOT NULL).
ALTER TABLE "assistant_rollouts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
