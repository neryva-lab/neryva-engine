-- 0049 — TPL-5.1 (agent_setup_ledger.md / _agent_setup_detail_plan.md §7.2 item 2):
-- release governance: resolved bindings on snapshots, per-run manifests,
-- eval decisions + provenance, environment/channel release pointers,
-- assistant kill flag, and operator control blocks.
--
-- Owner of all touched tables/columns: engine-ts (ownership-map.json).
-- Additive except (d): the rollout uniqueness change drops and replaces one
-- partial unique index (documented below). No backfill: new columns are
-- nullable or defaulted; pre-0049 snapshots simply carry null bindings
-- (provenance reads report them as unresolved — honest, not backfilled).
-- Rollback: drop the added columns/tables/indexes in reverse order; restore
-- uq_rollouts_active_per_assistant (statement recorded under (d)).

-- ── (a) policy_snapshots += resolved bindings (written in the publish TX) ──
ALTER TABLE "policy_snapshots" ADD COLUMN "tool_bindings" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "policy_snapshots" ADD COLUMN "knowledge_pins" jsonb;
ALTER TABLE "policy_snapshots" ADD COLUMN "model_ref" jsonb;
ALTER TABLE "policy_snapshots" ADD COLUMN "template_ref" jsonb;
ALTER TABLE "policy_snapshots" ADD COLUMN "manifest_hash" varchar(64);

-- ── (b) run_manifests (per-run execution manifest, written at acceptance) ───
CREATE TABLE "run_manifests" (
  "run_id" uuid PRIMARY KEY REFERENCES "runs"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "assistant_version_id" uuid NOT NULL,
  "policy_snapshot_id" uuid NOT NULL,
  "manifest" jsonb NOT NULL,
  "manifest_hash" varchar(64) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "run_manifests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_manifests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "run_manifests_tenant_isolation" ON "run_manifests"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_run_manifests_org_version" ON "run_manifests" USING btree ("organization_id", "assistant_version_id");

-- ── (c) eval_runs += decision + provenance ──────────────────────────────────
ALTER TABLE "eval_runs" ADD COLUMN "provenance" jsonb;
ALTER TABLE "eval_runs" ADD COLUMN "decision" varchar(16);
ALTER TABLE "eval_runs" ADD COLUMN "release_policy_version" integer;
ALTER TABLE "eval_runs" ADD CONSTRAINT "chk_eval_runs_decision" CHECK (decision IN ('PASS','WARN','BLOCK'));

-- ── (d) assistant_rollouts += environment/channel release pointers ──────────
-- Destructive step (constraint replacement): the old partial unique admits
-- exactly one active row per assistant, so no two active rows can collide on
-- the new (assistant_id, environment, channel) key — existing rows land on
-- ('production','default') via the column defaults. Rollback restores it with:
--   DROP INDEX "uq_rollouts_active_per_assistant_env_channel";
--   CREATE UNIQUE INDEX "uq_rollouts_active_per_assistant"
--     ON "assistant_rollouts" ("assistant_id") WHERE "state" = 'active';
ALTER TABLE "assistant_rollouts" ADD COLUMN "environment" varchar(32) NOT NULL DEFAULT 'production';
ALTER TABLE "assistant_rollouts" ADD COLUMN "channel" varchar(32) NOT NULL DEFAULT 'default';
DROP INDEX "uq_rollouts_active_per_assistant";
CREATE UNIQUE INDEX "uq_rollouts_active_per_assistant_env_channel" ON "assistant_rollouts" ("assistant_id", "environment", "channel") WHERE "state" = 'active';
CREATE INDEX "ix_rollouts_org_assistant_env" ON "assistant_rollouts" USING btree ("organization_id", "assistant_id", "environment", "channel");

-- ── (e) assistants += kill flag ─────────────────────────────────────────────
ALTER TABLE "assistants" ADD COLUMN "disabled_at" timestamptz;
ALTER TABLE "assistants" ADD COLUMN "disabled_by" varchar(128);
ALTER TABLE "assistants" ADD COLUMN "disabled_reason" varchar(512);

-- ── (f) control_blocks (operator kill switches with expiry) ─────────────────
CREATE TABLE "control_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "target_type" varchar(32) NOT NULL,
  "target_name" varchar(128) NOT NULL,
  "reason" varchar(512) NOT NULL,
  "expires_at" timestamptz,
  "created_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_control_blocks_target" CHECK (target_type IN ('assistant','version','tool','template','capability'))
);

ALTER TABLE "control_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "control_blocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "control_blocks_tenant_isolation" ON "control_blocks"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_control_blocks_org_target" ON "control_blocks" USING btree ("organization_id", "target_type", "target_name");
