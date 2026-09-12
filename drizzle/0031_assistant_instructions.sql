-- 0031 — assistant definition v2: instructions + model params (ai_harness_plan.md H0.1)
--
-- The assistant version payload had no system prompt and no generation
-- parameters: a run could not know its persona or its sampling config, and
-- the MCP ContextManifest served neither (contract v1.1 adds instructions +
-- model_params). Expand-only: new nullable columns, no existing reads change.
-- ASSISTANT_SCHEMA_VERSION moves to 2 in code; schema_version stays per-row
-- so legacy (v1) rows remain readable and publishable until re-saved.

ALTER TABLE "assistant_versions" ADD COLUMN "instructions" text;
ALTER TABLE "assistant_versions" ADD COLUMN "model_params" jsonb;

ALTER TABLE "policy_snapshots" ADD COLUMN "instructions" text;
ALTER TABLE "policy_snapshots" ADD COLUMN "model_params" jsonb;

-- Bounded like every prompt surface: 32 KiB covers any reasonable system
-- prompt; larger content belongs in knowledge, not the prompt.
ALTER TABLE "assistant_versions" ADD CONSTRAINT "chk_assistant_instructions_len" CHECK (char_length("instructions") <= 32768);
ALTER TABLE "policy_snapshots" ADD CONSTRAINT "chk_snapshot_instructions_len" CHECK (char_length("instructions") <= 32768);
