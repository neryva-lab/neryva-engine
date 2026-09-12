-- 0032 — tool catalog (ai_harness_plan.md H0.2)
--
-- tool_policy.tools carried freeform names with no JSON Schema: the model
-- could never emit a valid tool call, and effect classes were name-inferred.
-- Engine now owns a versioned, hashed tool catalog; assistant versions pin
-- catalog entries by (name, schema_hash) at publish time the same way they
-- pin model catalog entries, so a run can never see a mutated schema.
-- Contract v1.1 ToolDescriptor carries description/input_schema_json/annotations.

CREATE TABLE "tool_catalog" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "name" varchar(128) NOT NULL,
  "version" varchar(32) NOT NULL DEFAULT '1.0.0',
  "description" varchar(2048),
  "input_schema" jsonb NOT NULL,
  "output_schema" jsonb,
  -- effect_class and approval_requirement are orthogonal (tool.proto).
  "effect_class" varchar(16) NOT NULL DEFAULT 'READ_ONLY',
  "approval_requirement" varchar(16) NOT NULL DEFAULT 'NONE',
  -- Advisory capability hints aligned with MCP tool annotations.
  "annotations" jsonb NOT NULL DEFAULT '{}',
  -- Canonical sha256 of (name, version, input_schema, effect_class,
  -- approval_requirement, annotations) — the pin target for policy publish.
  "hash" varchar(64) NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_tool_catalog_effect" CHECK ("effect_class" IN ('READ_ONLY','MUTATING','DESTRUCTIVE')),
  CONSTRAINT "chk_tool_catalog_approval" CHECK ("approval_requirement" IN ('NONE','REQUIRED')),
  CONSTRAINT "uq_tool_catalog_org_name" UNIQUE ("organization_id", "name")
);

-- Tenant isolation: identical pattern to drizzle/0002_org_furniture.sql:68.
ALTER TABLE "tool_catalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_catalog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tool_catalog_tenant_isolation" ON "tool_catalog"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_tool_catalog_org_enabled" ON "tool_catalog" USING btree ("organization_id", "enabled", "updated_at" DESC);
