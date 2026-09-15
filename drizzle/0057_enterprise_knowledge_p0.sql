-- 0057 — Enterprise knowledge P0 (enterprise_gap_plan.md Build A foundation).
--
--   E-2 source slugs: documents.source_slug (unique per org, immutable
--     address for pin matching — replaces brittle title equality) +
--     upload_sessions.source_slug/title (user intent carried into ingestion).
--   P0-3 briefed handoff: escalations.brief (immutable brief-at-handoff).
--   P0-1 connectors: connector_oauth_apps (org BYO OAuth apps),
--     connector_documents (external-id → document map for delete
--     propagation), external_principals + external_identity_links +
--     document_source_acls (source permission sync model).
--   Retrieval support: documents.state gains 'retired' (tombstone for
--     source-deleted docs; retrieval already admits state='ready' only),
--     chunks composite index for pin-filtered plans.
--
-- RLS: ENABLE + FORCE with the pinned 0026/0030 USING/WITH CHECK shape on
-- every new organization_id table.

-- ── E-2: documents.source_slug ──────────────────────────────────────────
ALTER TABLE "documents" ADD COLUMN "source_slug" varchar(64);

DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT id, organization_id, title FROM documents WHERE source_slug IS NULL ORDER BY created_at, id LOOP
    base := lower(regexp_replace(coalesce(r.title, ''), '[^a-z0-9]+', '-', 'g'));
    base := regexp_replace(base, '(^-+|-+$)', '', 'g');
    IF base IS NULL OR length(base) < 3 THEN
      base := 'doc-' || substr(r.id::text, 1, 8);
    END IF;
    -- Cap the stem so even a large dedupe suffix stays within varchar(64).
    base := substr(base, 1, 59);
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM documents WHERE organization_id = r.organization_id AND source_slug = candidate AND id <> r.id) LOOP
      n := n + 1;
      candidate := substr(base, 1, 59) || '-' || n;
    END LOOP;
    UPDATE documents SET source_slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE "documents" ALTER COLUMN "source_slug" SET NOT NULL;
CREATE UNIQUE INDEX "uq_documents_org_slug" ON "documents" ("organization_id", "source_slug");

-- ── E-2: upload intent columns ──────────────────────────────────────────
ALTER TABLE "upload_sessions" ADD COLUMN "source_slug" varchar(64);
ALTER TABLE "upload_sessions" ADD COLUMN "title" varchar(256);
-- Connector provenance carried into ingestion (mapping + ACL + update
-- targeting). NULL for user uploads. target_document_id pins re-ingestion
-- onto an existing document (new version) instead of duplicating it.
ALTER TABLE "upload_sessions" ADD COLUMN "target_document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL;
ALTER TABLE "upload_sessions" ADD COLUMN "connector_ref" jsonb;
ALTER TABLE "upload_sessions" ADD COLUMN "source_acl" jsonb;

-- ── P0-3: escalation brief (immutable brief-at-handoff, nullable) ───────
ALTER TABLE "escalations" ADD COLUMN "brief" jsonb;

-- ── P0-1: org OAuth apps (BYO provider apps for connector OAuth dance) ──
CREATE TABLE "connector_oauth_apps" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "client_id" varchar(512) NOT NULL,
  "client_secret_sealed" text NOT NULL,
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_connector_oauth_apps_org_provider" UNIQUE ("organization_id", "provider")
);
ALTER TABLE "connector_oauth_apps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connector_oauth_apps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connector_oauth_apps_tenant_isolation" ON "connector_oauth_apps"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── P0-1: external-id → document map (delete propagation) ───────────────
CREATE TABLE "connector_documents" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "connector_account_id" uuid NOT NULL REFERENCES "connector_accounts"("id") ON DELETE CASCADE,
  "external_id" varchar(512) NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_connector_documents_account_external" UNIQUE ("organization_id", "connector_account_id", "external_id")
);
ALTER TABLE "connector_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connector_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connector_documents_tenant_isolation" ON "connector_documents"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
CREATE INDEX "ix_connector_documents_document" ON "connector_documents" ("document_id");

-- ── P0-1: external principals (source permission sync model) ────────────
-- A principal is a user, group, or domain known to an external source
-- (Drive permission id, Graph identity, Confluence account). Matching to
-- Engine callers happens by verified email first, then by explicit link.
CREATE TABLE "external_principals" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "external_id" varchar(512) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "email" varchar(320),
  "display" varchar(256),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_external_principals_org_provider_external" UNIQUE ("organization_id", "provider", "external_id"),
  CONSTRAINT "chk_external_principals_kind" CHECK (kind IN ('user', 'group', 'domain'))
);
ALTER TABLE "external_principals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_principals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "external_principals_tenant_isolation" ON "external_principals"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
CREATE INDEX "ix_external_principals_org_email" ON "external_principals" ("organization_id", "email");

-- Explicit external-id → account links (auto-created on email equality at
-- sync; manageable where automation must not guess).
CREATE TABLE "external_identity_links" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "external_id" varchar(512) NOT NULL,
  "account_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_external_identity_links" UNIQUE ("organization_id", "provider", "external_id")
);
ALTER TABLE "external_identity_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_identity_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "external_identity_links_tenant_isolation" ON "external_identity_links"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
CREATE INDEX "ix_external_identity_links_account" ON "external_identity_links" ("organization_id", "account_id");

-- Per-document source allow-lists. A document WITH rows here is restricted:
-- retrieval admits it only for callers matching a listed principal (by
-- linked account or verified email). A document with NO rows keeps the
-- legacy posture (org visibility via retrieval_acl).
CREATE TABLE "document_source_acls" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "provider" varchar(32) NOT NULL,
  "external_id" varchar(512) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_document_source_acls" UNIQUE ("document_id", "provider", "external_id")
);
ALTER TABLE "document_source_acls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_source_acls" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_source_acls_tenant_isolation" ON "document_source_acls"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
CREATE INDEX "ix_document_source_acls_org_doc" ON "document_source_acls" ("organization_id", "document_id");

-- ── Retrieval support: pin-filtered plans + retired tombstones ──────────
CREATE INDEX "ix_chunks_org_version" ON "chunks" ("organization_id", "document_version_id");
