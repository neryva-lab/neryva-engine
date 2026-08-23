-- eng-0016: config-publish depth (handover A-4 v2). The draft layer,
-- publish metadata, and the notification-ledger index the retention sweep
-- needs. published_configs stays append-only — the new columns are written
-- once at INSERT time and never updated.

-- Publish metadata: operator note + rollback lineage (set at insert only).
ALTER TABLE published_configs ADD COLUMN notes varchar(512);
ALTER TABLE published_configs ADD COLUMN rollback_of integer;

-- The draft layer: one mutable draft per (org, scope, product). A draft can
-- be saved invalid (its validation report rides along); publish requires
-- 'valid'. Org-scoped like published_configs (RLS, same policy shape).
CREATE TABLE config_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  scope varchar(32) NOT NULL,
  product varchar(64),
  payload jsonb NOT NULL,
  payload_hash varchar(64) NOT NULL,
  validation_status varchar(16) NOT NULL,       -- 'valid' | 'invalid'
  validation_issues jsonb,
  notes varchar(512),
  created_by varchar(128) NOT NULL,
  updated_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- NULLS NOT DISTINCT: an org-wide draft (product NULL) must still be
-- UNIQUE per (org, scope) — without it Postgres treats NULLs as distinct
-- and the draft upsert would silently insert duplicates. (published_configs
-- needs no such fix: its versions are assigned under the per-key advisory
-- lock, so its NULL-product rows never race.)
CREATE UNIQUE INDEX uq_config_drafts_key ON config_drafts (org_id, scope, product) NULLS NOT DISTINCT;
CREATE INDEX ix_config_drafts_org ON config_drafts (org_id, updated_at);

ALTER TABLE config_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_drafts
  USING (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  )
  WITH CHECK (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  );

-- Retention/queue scans: pendingFor(satellite) filters (satellite_key,
-- acked_at IS NULL) and the GC sweep deletes by (satellite_key, acked_at).
CREATE INDEX ix_config_notifications_satellite_acked ON config_notifications (satellite_key, acked_at);
