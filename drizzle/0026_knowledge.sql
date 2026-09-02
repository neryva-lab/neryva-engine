-- 0026_knowledge — Phase 7: artifacts, upload sessions, documents/chunks/embeddings
-- (imp/ledger.md tasks 7.1-7.8). Engine owns metadata + access state; object
-- storage owns bytes; chunks/embeddings are derived and rebuildable. Tenant
-- isolation: ENABLE + FORCE RLS everywhere organization_id exists; object keys
-- are tenant-bound `org/{org_id}/{purpose}/{uuid}`.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── artifacts (claim-check metadata; 7-check facade in ArtifactsService) ────
CREATE TABLE "artifacts" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "purpose" varchar(32) NOT NULL,
  "object_key" varchar(512) NOT NULL,
  "content_type_declared" varchar(128) NOT NULL,
  "content_type_detected" varchar(128),
  "byte_length" bigint NOT NULL,
  "sha256" bytea NOT NULL,
  "encryption_key_ref" varchar(128),
  "scan_status" varchar(32) NOT NULL DEFAULT 'pending',
  "state" varchar(32) NOT NULL DEFAULT 'active',
  "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
  "expires_at" timestamptz,
  "created_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_artifacts_purpose" CHECK (purpose IN ('SOURCE_DOCUMENT','EXPORT','CHECKPOINT','TOOL_RESULT','TRANSCRIPT','COVER')),
  CONSTRAINT "chk_artifacts_scan" CHECK (scan_status IN ('pending','clean','infected','skipped')),
  CONSTRAINT "chk_artifacts_state" CHECK (state IN ('active','retiring','purged'))
);

ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "artifacts_tenant_isolation" ON "artifacts"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE UNIQUE INDEX "uq_artifacts_object_key" ON "artifacts" ("object_key");
CREATE INDEX "ix_artifacts_org_purpose" ON "artifacts" USING btree ("organization_id", "purpose", "created_at" DESC);

-- ── upload_sessions (state machine per engine_architecture.md:425-443) ──────
CREATE TABLE "upload_sessions" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "purpose" varchar(32) NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "media_type" varchar(128) NOT NULL,
  "byte_length" bigint NOT NULL,
  "state" varchar(32) NOT NULL DEFAULT 'CREATED',
  "expires_at" timestamptz NOT NULL,
  "last_error" text,
  "locked_at" timestamptz,
  "created_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_upload_state" CHECK (state IN ('CREATED','UPLOADING','UPLOADED','SCANNING','EXTRACTING','INDEXING','READY','QUARANTINED','FAILED'))
);

ALTER TABLE "upload_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "upload_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "upload_sessions_tenant_isolation" ON "upload_sessions"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_upload_sessions_state" ON "upload_sessions" ("state", "created_at") WHERE state IN ('UPLOADED','SCANNING','EXTRACTING','INDEXING');

-- ── documents / document_versions / chunks / embeddings (derived, rebuildable) ──
CREATE TABLE "documents" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "source_artifact_id" uuid NOT NULL REFERENCES "artifacts"("id"),
  "title" varchar(256),
  "state" varchar(32) NOT NULL DEFAULT 'processing',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_documents_state" CHECK (state IN ('processing','ready','failed')),
  CONSTRAINT "uq_documents_source_artifact" UNIQUE ("source_artifact_id")
);

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "documents_tenant_isolation" ON "documents"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_documents_org_state" ON "documents" USING btree ("organization_id", "state");

CREATE TABLE "document_versions" (
  "id" uuid PRIMARY KEY,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "sha256" bytea NOT NULL,
  "parser_version" varchar(32) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_document_versions" UNIQUE ("document_id", "sha256", "parser_version")
);

ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_versions_tenant_isolation" ON "document_versions"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE TABLE "chunks" (
  "id" uuid PRIMARY KEY,
  "document_version_id" uuid NOT NULL REFERENCES "document_versions"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "source_range" jsonb NOT NULL,
  "chunk_hash" varchar(64) NOT NULL,
  "text" varchar(8192) NOT NULL,
  CONSTRAINT "uq_chunks_version_sequence" UNIQUE ("document_version_id", "sequence")
);

ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "chunks_tenant_isolation" ON "chunks"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE TABLE "embeddings" (
  "id" uuid PRIMARY KEY,
  "chunk_id" uuid NOT NULL REFERENCES "chunks"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "model" varchar(64) NOT NULL,
  "embedding" vector(1536) NOT NULL,
  CONSTRAINT "uq_embeddings_chunk" UNIQUE ("chunk_id", "model")
);

ALTER TABLE "embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "embeddings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "embeddings_tenant_isolation" ON "embeddings"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── retrieval_acl (authorization BEFORE scoring; ledger 7.7) ────────────────
CREATE TABLE "retrieval_acl" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "resource_type" varchar(32) NOT NULL DEFAULT 'document',
  "resource_id" uuid NOT NULL,
  "visibility" varchar(32) NOT NULL DEFAULT 'organization',
  "scope_account_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_acl_visibility" CHECK (visibility IN ('organization','private')),
  CONSTRAINT "uq_retrieval_acl" UNIQUE ("resource_type", "resource_id", "visibility", "scope_account_id")
);

ALTER TABLE "retrieval_acl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "retrieval_acl" FORCE ROW LEVEL SECURITY;
CREATE POLICY "retrieval_acl_tenant_isolation" ON "retrieval_acl"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_retrieval_acl_resource" ON "retrieval_acl" USING btree ("organization_id", "resource_type", "resource_id");

-- ── memory_items (7.8, pinned here) — proposals become truth only on approval ──
CREATE TABLE "memory_items" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "scope_type" varchar(32) NOT NULL,
  "scope_id" uuid,
  "content" varchar(8192) NOT NULL,
  "source_ref" jsonb,
  "provenance" varchar(1024),
  "confidence" numeric(4, 3),
  "visibility" varchar(32) NOT NULL DEFAULT 'organization',
  "expires_at" timestamptz,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_memory_scope" CHECK (scope_type IN ('organization','conversation','assistant','user')),
  CONSTRAINT "chk_memory_visibility" CHECK (visibility IN ('organization','private'))
);

ALTER TABLE "memory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memory_items_tenant_isolation" ON "memory_items"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_memory_items_scope" ON "memory_items" USING btree ("organization_id", "scope_type", "scope_id");
