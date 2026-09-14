-- 0052 — REL-2.2/REL-2.4 (release_ledger.md): the eval execution ledger and
-- non-standard run kinds.
--
-- eval_case_executions is the durable link between an eval run and the real
-- conversation-plane runs that execute its cases: one row per (eval_run,
-- case, attempt), claimed idempotently by the engine-side executor, scored
-- by the run.completed consumer, and folded into evalResultsSchema results
-- for EvalService.completeRun (the decision engine). WITHOUT this table the
-- `eval.run_requested` event has no consumer (GAP-03) and no eval decision
-- can ever exist.
--
-- runs.run_kind marks runs that are NOT billable production traffic:
--   standard — the default; every existing run.
--   test     — pre-publish draft executions (REL-2.4): excluded from usage
--              ledger entries, rollups, and end-user surfaces.
--   eval     — eval-harness executions (REL-2.2): same exclusions.
-- The usage consumer and rollups filter on this column; billing truth is
-- unaffected for standard runs.

ALTER TABLE "runs" ADD COLUMN "run_kind" varchar(16) NOT NULL DEFAULT 'standard';
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "chk_runs_run_kind" CHECK ("run_kind" IN ('standard', 'test', 'eval'));
--> statement-breakpoint
CREATE TABLE "eval_case_executions" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "eval_run_id" uuid NOT NULL REFERENCES "eval_runs"("id") ON DELETE CASCADE,
  "case_id" uuid NOT NULL REFERENCES "eval_cases"("id") ON DELETE CASCADE,
  "attempt" integer NOT NULL,
  "conversation_id" uuid,
  "run_id" uuid,
  /** pending | passed | failed */
  "state" varchar(16) NOT NULL DEFAULT 'pending',
  "score" numeric(5, 4),
  "response_excerpt" varchar(512),
  "failure_reason" varchar(512),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_eval_case_executions_state" CHECK ("state" IN ('pending', 'passed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_eval_case_executions_case_attempt" ON "eval_case_executions" ("eval_run_id", "case_id", "attempt");
--> statement-breakpoint
CREATE INDEX "ix_eval_case_executions_org_run" ON "eval_case_executions" ("organization_id", "eval_run_id");
--> statement-breakpoint
CREATE INDEX "ix_eval_case_executions_run_id" ON "eval_case_executions" ("run_id");
--> statement-breakpoint
ALTER TABLE "eval_case_executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eval_case_executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "eval_case_executions_tenant_isolation" ON "eval_case_executions"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
