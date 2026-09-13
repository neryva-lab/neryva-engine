-- 0048 — TPL-1.1 (agent_setup_ledger.md / _agent_setup_detail_plan.md §7.2 item 1):
-- agent template registry + per-org installs. Schema only — no template rows ship
-- in DDL; rows arrive via the §7.1 release-job upsert of registry.json (idempotent,
-- keyed (slug, version), hash + min_engine_schema validated before write).
--
-- Design note (corrects the "(slug PK)" shorthand in TPL-1.1): the registry keeps
-- EVERY released version, so the key is composite PRIMARY KEY (slug, version).
-- A slug-only PK could hold just the latest row and could not answer provenance
-- reads for older installs (template_slug@version on version reads, TPL-4.2) or
-- "new draft from vX.Y.Z" upgrades (§7.4). The sync upsert key (slug, version)
-- in TPL-1.2 is authoritative; the ledger scope line is fixed in the same change.
--
-- assistant_templates is GLOBAL, non-tenant seed data: no organization_id column,
-- no RLS — precedent billing.price_catalog (drizzle/0011_platform_services.sql:80-96).
-- assistant_installs is TENANT data: RLS ENABLE + FORCE with the assistants-shape
-- predicate (drizzle/0020_assistants.sql:18-20). Owner of both tables: engine-ts.
-- No destructive step; no backfill; rollback = drop the two tables (no dependents yet).

-- ── assistant_templates (global registry mirror, one row per released version) ──
CREATE TABLE "assistant_templates" (
  "slug" varchar(64) NOT NULL,
  "version" varchar(32) NOT NULL,
  "status" varchar(16) NOT NULL,
  "family" varchar(32) NOT NULL,
  "definition" jsonb NOT NULL,
  "bindings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "eval_ref" jsonb,
  "release_policy" jsonb NOT NULL,
  "hash" varchar(64) NOT NULL,
  "min_engine_schema" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_assistant_templates_slug_version" PRIMARY KEY ("slug", "version"),
  CONSTRAINT "chk_assistant_templates_status" CHECK (status IN ('stable','beta','deprecated'))
);

CREATE INDEX "ix_assistant_templates_status" ON "assistant_templates" USING btree ("status");
CREATE INDEX "ix_assistant_templates_family" ON "assistant_templates" USING btree ("family");

-- ── assistant_installs (per-org install record: copy provenance, never a live link) ──
CREATE TABLE "assistant_installs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "slug" varchar(64) NOT NULL,
  "template_version" varchar(32) NOT NULL,
  "assistant_id" uuid NOT NULL REFERENCES "assistants"("id") ON DELETE CASCADE,
  "installed_by" varchar(128),
  "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
  "installed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "assistant_installs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_installs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assistant_installs_tenant_isolation" ON "assistant_installs"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- One install record per assistant (install creates the assistant 1:1 in TPL-2.2).
CREATE UNIQUE INDEX "uq_assistant_installs_assistant" ON "assistant_installs" USING btree ("assistant_id");
-- Registry-vs-installed lookups (org + slug@version) for list surfacing + checkUpdates.
CREATE INDEX "ix_assistant_installs_org_slug" ON "assistant_installs" USING btree ("organization_id", "slug", "template_version");
