-- 0028_lifecycle — Phase 9 (imp/ledger.md 9.3-9.8): retention policies, legal
-- holds, exports, purge tasks with ordered deletion, tombstones, and the
-- sensitive data-access record stream (separate from audit_events).

-- ── retention_policies (9.3) ────────────────────────────────────────────────
CREATE TABLE "retention_policies" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "resource_type" varchar(32) NOT NULL,
  "retention_class" varchar(32) NOT NULL,
  "keep_until_rule" jsonb NOT NULL,
  "created_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_retention_policies" UNIQUE ("organization_id", "resource_type", "retention_class")
);

ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retention_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "retention_policies_tenant_isolation" ON "retention_policies"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── legal_holds (9.4 — blocks purge, never retention work) ──────────────────
CREATE TABLE "legal_holds" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "scope_type" varchar(32) NOT NULL,
  "scope_id" uuid,
  "hold_reason" varchar(512) NOT NULL,
  "placed_by" varchar(128) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'active',
  "placed_at" timestamptz NOT NULL DEFAULT now(),
  "released_at" timestamptz,
  "expires_at" timestamptz,
  CONSTRAINT "chk_hold_scope" CHECK (scope_type IN ('organization','user','conversation','assistant')),
  CONSTRAINT "chk_hold_status" CHECK (status IN ('active','released'))
);

ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "legal_holds_tenant_isolation" ON "legal_holds"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_legal_holds_scope" ON "legal_holds" USING btree ("organization_id", "scope_type", "scope_id", "status");

-- ── export_requests (9.5) ───────────────────────────────────────────────────
CREATE TABLE "export_requests" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "actor_id" varchar(128) NOT NULL,
  "scope" jsonb NOT NULL,
  "manifest" jsonb,
  "state" varchar(32) NOT NULL DEFAULT 'pending',
  "artifact_id" uuid,
  "encryption_key_ref" varchar(128),
  "download_token_hash" varchar(64),
  "download_count" integer NOT NULL DEFAULT 0,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "chk_export_state" CHECK (state IN ('pending','generating','ready','expired','failed'))
);

ALTER TABLE "export_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "export_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "export_requests_tenant_isolation" ON "export_requests"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── purge_tasks (9.6 — ordered, idempotent, resumable) ──────────────────────
CREATE TABLE "purge_tasks" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "scope_type" varchar(32) NOT NULL,
  "scope_id" uuid NOT NULL,
  "reason" varchar(64) NOT NULL,
  "state" varchar(32) NOT NULL DEFAULT 'pending',
  "step" varchar(32) NOT NULL DEFAULT 'authorize',
  "last_error" text,
  "evidence" jsonb,
  "locked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "chk_purge_state" CHECK (state IN ('pending','in_progress','done','failed','blocked')),
  CONSTRAINT "chk_purge_step" CHECK (step IN ('authorize','check_holds','mark_unavailable','emit_derived_deletion','purge_objects','purge_content','tombstone','done'))
);

ALTER TABLE "purge_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purge_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "purge_tasks_tenant_isolation" ON "purge_tasks"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_purge_tasks_state" ON "purge_tasks" ("state", "created_at") WHERE state IN ('pending','in_progress');

-- ── tombstones (9.8 — stale IDs rejected after purge) ───────────────────────
CREATE TABLE "tombstones" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid,
  "resource_type" varchar(32) NOT NULL,
  "resource_id" uuid NOT NULL,
  "reason" varchar(64) NOT NULL,
  "purged_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_tombstones" UNIQUE ("resource_type", "resource_id")
);

-- Platform-plane: read by MCP/console paths across tenants post-purge; rows
-- carry organization_id only for evidence, not for tenant reads.

-- ── data_access_records (9.7 — sensitive-read stream, separate from audit) ──
CREATE TABLE "data_access_records" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid,
  "actor_type" varchar(32) NOT NULL,
  "actor_id" varchar(128) NOT NULL,
  "access_type" varchar(32) NOT NULL,
  "resource_type" varchar(32) NOT NULL,
  "resource_id" uuid,
  "justification" varchar(512),
  "trace_id" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_dar_access" CHECK (access_type IN ('export_download','sensitive_read','support_access','policy_change','impersonation'))
);

CREATE INDEX "ix_dar_created" ON "data_access_records" USING btree ("created_at" DESC);
