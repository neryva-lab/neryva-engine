-- 0040 — Harness parity tables (final_ledger.md FL-2.10/2.18/2.19/2.21/2.22/2.23)
--
-- One ordered migration for the remaining FL-2 schema surfaces. Every table
-- is engine-ts owned, organization-scoped, RLS ENABLE + FORCE with the pinned
-- tenant policy.

-- ── FL-2.10: HTTP tool executor binding on catalog entries ──────────────────
ALTER TABLE "tool_catalog" ADD COLUMN "http_binding" jsonb;
ALTER TABLE "tool_catalog" ADD COLUMN "credential_sealed" text;
ALTER TABLE "tool_catalog" ADD COLUMN "rate_limit_per_run" integer;
-- Binding shape: {url, method, timeout_ms, header_name}. Credentials are
-- envelope-sealed (enc:v1:) at write; disclosure happens ONLY via the scoped
-- GetToolCredential MCP op, never through the manifest.

-- ── FL-2.18/2.19: org model routing + residency ────────────────────────────
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "residency_class" varchar(32) NOT NULL DEFAULT 'default';
-- Per-org BYOK virtual keys live in the published `knowledge_config`-style
-- config surface (`model_routing` scope) as enc:v1:-sealed LiteLLM virtual
-- keys; no new table (config-publish is the org config system of record).

-- ── FL-2.21: eval datasets / cases / runs ───────────────────────────────────
CREATE TABLE "eval_datasets" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "name" varchar(128) NOT NULL,
  "description" varchar(2048),
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_eval_datasets_org_name" UNIQUE (organization_id, name)
);

CREATE TABLE "eval_cases" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "eval_datasets"("id") ON DELETE CASCADE,
  "input" jsonb NOT NULL,
  "expected" jsonb NOT NULL,
  /** tau2-style state assertions + LLM-judge rubric (optional). */
  "rubric" jsonb,
  "sequence" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "ix_eval_cases_dataset" ON "eval_cases" ("organization_id", "dataset_id", "sequence");

CREATE TABLE "eval_runs" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "eval_datasets"("id"),
  "assistant_version_id" uuid NOT NULL REFERENCES "assistant_versions"("id"),
  /** pending | running | completed | failed */
  "state" varchar(32) NOT NULL DEFAULT 'pending',
  /** pass^k methodology: each case attempted k times. */
  "attempts_per_case" integer NOT NULL DEFAULT 1,
  "results" jsonb,
  "score" numeric(5, 4),
  "started_by" varchar(128) NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "chk_eval_runs_state" CHECK (state IN ('pending','running','completed','failed'))
);
CREATE INDEX "ix_eval_runs_org_dataset" ON "eval_runs" ("organization_id", "dataset_id", "started_at");

-- ── FL-2.22/2.23: analytics rollups (feedback + conversation aggregates) ────
CREATE TABLE "analytics_rollups" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  /** csat_daily | conversation_outcomes_daily | usage_daily */
  "kind" varchar(32) NOT NULL,
  /** yyyy-mm-dd bucket. */
  "period_start" date NOT NULL,
  /** Keyed scope: {assistant_id?, conversation_segment?}. */
  "scope" jsonb NOT NULL DEFAULT '{}',
  "metrics" jsonb NOT NULL,
  "computed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_analytics_rollups_scope" UNIQUE (organization_id, kind, period_start, scope)
);
CREATE INDEX "ix_analytics_rollups_org_kind" ON "analytics_rollups" ("organization_id", "kind", "period_start");

ALTER TABLE "eval_datasets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eval_datasets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "eval_datasets_tenant_isolation" ON "eval_datasets"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
ALTER TABLE "eval_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eval_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "eval_cases_tenant_isolation" ON "eval_cases"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eval_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "eval_runs_tenant_isolation" ON "eval_runs"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
ALTER TABLE "analytics_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_rollups_tenant_isolation" ON "analytics_rollups"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
