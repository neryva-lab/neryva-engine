-- 0058 — Operate visibility (agent-setup.md review round).
--
-- assistant_rollouts gains pause attribution so a paused rollout explains
-- ITSELF on reads (GET rollout returns the full row): manual pauses record
-- the actor, burn-rate auto-pauses record the reason + costs. No backfill
-- (existing paused rows keep NULL reason = "paused before attribution");
-- readers treat NULL as operator-paused-legacy.
ALTER TABLE "assistant_rollouts" ADD COLUMN "paused_reason" varchar(512);
ALTER TABLE "assistant_rollouts" ADD COLUMN "paused_by" varchar(128);
ALTER TABLE "assistant_rollouts" ADD COLUMN "paused_at" timestamptz;
