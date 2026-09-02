-- 0021_policy_snapshots — Phase 3.1 (pinned decision 2026-09-01, see imp/ledger.md task 3.1):
-- one immutable policy snapshot per published assistant_versions row, materialized in the
-- same TX as publish. Runs (Phase 4.4) pin assistant_version_id + policy_snapshot_id at
-- acceptance; snapshot rows are never mutated and never deleted except via lifecycle purge.

CREATE TABLE "policy_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "assistant_version_id" uuid NOT NULL REFERENCES "assistant_versions"("id") ON DELETE CASCADE,
  "snapshot_version" integer NOT NULL DEFAULT 1,
  "model_policy" jsonb NOT NULL,
  "context_policy" jsonb NOT NULL,
  "tool_policy" jsonb NOT NULL,
  "guardrail_policy" jsonb NOT NULL,
  "knowledge_policy" jsonb,
  "hash" varchar(64) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "policy_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "policy_snapshots_tenant_isolation" ON "policy_snapshots"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- 1:1 with published versions; the pinning authority for Phase 4 runs.
CREATE UNIQUE INDEX "uq_policy_snapshots_version" ON "policy_snapshots" USING btree ("assistant_version_id");
CREATE INDEX "ix_policy_snapshots_org_created" ON "policy_snapshots" USING btree ("organization_id", "created_at");
