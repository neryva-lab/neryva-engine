-- 0020_assistants — Phase 3.1: assistants + assistant_versions (immutable publish)
-- Tenant-isolated via organization_id (shared tables, RLS FORCE) — see engine_architecture.md:263

-- ── assistants (stable identity) ─────────────────────────────────────────────
CREATE TABLE "assistants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "name" varchar(128) NOT NULL,
  "description" varchar(512),
  "active_version_id" uuid,
  "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "assistants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assistants_tenant_isolation" ON "assistants"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE UNIQUE INDEX "uq_assistants_org_name" ON "assistants" USING btree ("organization_id", "name");
CREATE INDEX "ix_assistants_org" ON "assistants" USING btree ("organization_id", "updated_at");

-- ── assistant_versions (immutable history, version monotonic per assistant) ──
CREATE TABLE "assistant_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistant_id" uuid NOT NULL REFERENCES "assistants"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "status" varchar(32) NOT NULL,
  "model_policy" jsonb NOT NULL,
  "context_policy" jsonb NOT NULL,
  "tool_policy" jsonb NOT NULL,
  "knowledge_policy" jsonb,
  "guardrail_policy" jsonb NOT NULL,
  "rollback_of" uuid,
  "hash" varchar(64) NOT NULL,
  "published_at" timestamptz,
  "published_by" varchar(128),
  "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_assistant_versions_status" CHECK (status IN ('DRAFT','VALIDATING','VALID','PUBLISHED','RETIRED','ROLLED_BACK'))
);

ALTER TABLE "assistant_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assistant_versions_tenant_isolation" ON "assistant_versions"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE UNIQUE INDEX "uq_assistant_versions_assistant_version" ON "assistant_versions" USING btree ("assistant_id", "version");
CREATE UNIQUE INDEX "uq_assistant_versions_id_org" ON "assistant_versions" USING btree ("id", "organization_id");
CREATE INDEX "ix_assistant_versions_org_assistant" ON "assistant_versions" USING btree ("organization_id", "assistant_id", "version");
CREATE INDEX "ix_assistant_versions_org_status" ON "assistant_versions" USING btree ("organization_id", "status");

-- FK from assistants.active_version_id → assistant_versions.id is intentionally NOT a DB FK to avoid circular
-- dependency on write; the service validates that the referenced version belongs to the same assistant and org
-- inside the advisory-lock transaction. See src/modules/assistants/assistants.service.ts:1
