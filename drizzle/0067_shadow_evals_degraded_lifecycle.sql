-- 0067 — Shadow evals + degraded lifecycle (ai-native-review.md P5).
--
-- eval_runs.is_shadow: drift-triggered re-evaluations observe quality without
-- ever gating releases. FALSE for every historical row (formal evals only
-- existed before this). The publish gate + provenance verdict reads MUST
-- exclude shadow rows (see release-gate.ts) — a shadow BLOCK observes drift,
-- it never blocks shipping.
--
-- assistants.degraded_*: publish-with-bypass starts a 7-day clock instead of
-- a silent waiver. degraded_until = now + 7d, degraded_reason names the
-- waived slugs, degraded_alerted_at marks the T-24h notice. A healthy
-- publish clears all three. Past-TTL rows auto-suspend (disable path).
ALTER TABLE "eval_runs" ADD COLUMN "is_shadow" boolean NOT NULL DEFAULT false;
ALTER TABLE "assistants" ADD COLUMN "degraded_until" timestamptz;
ALTER TABLE "assistants" ADD COLUMN "degraded_reason" varchar(512);
ALTER TABLE "assistants" ADD COLUMN "degraded_alerted_at" timestamptz;
