-- 0039 — Knowledge connectors (final_ledger.md FL-2.5)
--
-- Connector accounts link an org to an external source (sitemap now;
-- Drive/Notion/Confluence ports land with their OAuth apps). Synced content
-- flows through the EXISTING upload-session pipeline: the connector stores
-- bytes under the org's SOURCE_DOCUMENT prefix, creates the artifact row and
-- an UPLOADED upload_session, and the ingestion worker owns scanning/
-- extraction/indexing — one ingestion path, no bypass.
-- Credentials (OAuth tokens) are envelope-sealed `enc:v1:` at write time —
-- the same discipline as channel accounts.

CREATE TABLE "connector_accounts" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "display_name" varchar(128) NOT NULL,
  /** Provider config (e.g. {sitemap_url}) — never credentials. */
  "config" jsonb NOT NULL DEFAULT '{}',
  /** Envelope-sealed OAuth tokens (enc:v1:) — provider-dependent. */
  "credentials_sealed" jsonb,
  /** active | paused | error */
  "state" varchar(32) NOT NULL DEFAULT 'active',
  /** Opaque incremental-sync cursor (per-provider shape). */
  "cursor" jsonb NOT NULL DEFAULT '{}',
  "last_synced_at" timestamptz,
  "last_error" varchar(512),
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_connector_provider" CHECK (provider IN ('sitemap','google_drive','notion','confluence')),
  CONSTRAINT "chk_connector_state" CHECK (state IN ('active','paused','error')),
  CONSTRAINT "uq_connector_accounts_org_provider_name" UNIQUE (organization_id, provider, display_name)
);
CREATE INDEX "ix_connector_accounts_org_state" ON "connector_accounts" ("organization_id", "state", "last_synced_at");

ALTER TABLE "connector_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connector_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connector_accounts_tenant_isolation" ON "connector_accounts"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
