-- 0024_mcp_authority — Phase 5: persistence for the Engine authority side of
-- neryva.mcp.v1 (imp/ledger.md tasks 5.4-5.10). All tables carry organization_id
-- with the standard RLS FORCE policy. IDs are application-generated UUIDv7.

-- runs.version: optimistic-concurrency counter backing the wire contract's
-- expected_version CAS (CommitRunResult/FailRun) — bumped on every state change.
ALTER TABLE "runs" ADD COLUMN "version" bigint NOT NULL DEFAULT 1;

-- ── run_idempotency (run-scoped RPC idempotency for Studio callers) ─────────
CREATE TABLE "run_idempotency" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "caller_scope" varchar(128) NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'IN_PROGRESS',
  "resource_ref" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "uq_run_idempotency_scope" UNIQUE ("organization_id", "caller_scope", "idempotency_key"),
  CONSTRAINT "chk_run_idem_status" CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL'))
);

ALTER TABLE "run_idempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_idempotency" FORCE ROW LEVEL SECURITY;
CREATE POLICY "run_idempotency_tenant_isolation" ON "run_idempotency"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_run_idempotency_run" ON "run_idempotency" USING btree ("run_id", "expires_at");

-- ── approvals (human-in-the-loop requests created via MCP) ──────────────────
CREATE TABLE "approvals" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "approval_ref" varchar(64) NOT NULL,
  "summary" varchar(512) NOT NULL,
  "action_type" varchar(64),
  "policy_version" varchar(32),
  "state" varchar(32) NOT NULL DEFAULT 'PENDING',
  "expires_at" timestamptz NOT NULL,
  "decision_actor_id" varchar(128),
  "decided_at" timestamptz,
  "decision_id" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_approvals_org_ref" UNIQUE ("organization_id", "approval_ref"),
  CONSTRAINT "chk_approvals_state" CHECK (state IN ('PENDING','APPROVED','DENIED','EXPIRED'))
);

ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approvals_tenant_isolation" ON "approvals"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_approvals_run_state" ON "approvals" USING btree ("run_id", "state");

-- ── tool_effects (AuthorizeToolCall + RecordToolOutcome dedup ledger) ───────
CREATE TABLE "tool_effects" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "step_id" varchar(64),
  "tool_call_id" varchar(128) NOT NULL,
  "tool_name" varchar(128) NOT NULL,
  "tool_version" varchar(32),
  "argument_digest" bytea,
  "result_digest" bytea,
  "status" varchar(32),
  "result_artifact_id" uuid,
  "authorized_at" timestamptz NOT NULL DEFAULT now(),
  "recorded_at" timestamptz,
  CONSTRAINT "uq_tool_effects_call" UNIQUE ("organization_id", "tool_call_id")
);

ALTER TABLE "tool_effects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_effects" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tool_effects_tenant_isolation" ON "tool_effects"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_tool_effects_run" ON "tool_effects" USING btree ("run_id", "authorized_at");

-- ── checkpoints (claim-check pointers; bytes live in object storage, Phase 7) ──
CREATE TABLE "checkpoints" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "checkpoint_ref" varchar(64) NOT NULL,
  "checkpoint_version" integer NOT NULL,
  "artifact_id" uuid,
  "digest" bytea NOT NULL,
  "producer" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_checkpoints_run_version" UNIQUE ("run_id", "checkpoint_ref", "checkpoint_version")
);

ALTER TABLE "checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "checkpoints_tenant_isolation" ON "checkpoints"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── memory_proposals (proposals are NOT durable memory until Engine approves — Phase 7 wires memory_items) ──
CREATE TABLE "memory_proposals" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "proposal_ref" varchar(64) NOT NULL,
  "scope" varchar(32) NOT NULL,
  "value" varchar(8192) NOT NULL,
  "provenance" varchar(1024),
  "confidence" numeric(4, 3),
  "visibility" varchar(32),
  "expires_at" timestamptz,
  "decision" varchar(32) NOT NULL DEFAULT 'PENDING',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_memory_proposals_org_ref" UNIQUE ("organization_id", "proposal_ref"),
  CONSTRAINT "chk_memory_decision" CHECK (decision IN ('PENDING','APPROVED','REJECTED'))
);

ALTER TABLE "memory_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memory_proposals_tenant_isolation" ON "memory_proposals"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_memory_proposals_run" ON "memory_proposals" USING btree ("run_id", "decision");
