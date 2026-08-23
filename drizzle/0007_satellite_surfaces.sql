-- eng-0007: the satellite connection surfaces (handover A-4 engine side +
-- the satellite registry). Engine-owned from creation.
--
-- published_configs is ORG-SCOPED (RLS per org_id, same policy shape as
-- eng-0002); satellites and config_notifications are platform-plane (no
-- RLS — the engine and its satellites are the only readers/writers).

-- ── The satellite registry (inference pre-registered as placeholder) ─────
CREATE TABLE satellites (
  key varchar(64) PRIMARY KEY,
  kind varchar(32) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',  -- active | placeholder | offline | retired
  route_prefixes jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_client_id varchar(64),
  products jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at timestamptz,
  last_heartbeat_version varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_satellites_status ON satellites (status);

-- ── Engine-published configs (A-4: the engine decides; satellites enforce) ──
CREATE TABLE published_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  scope varchar(32) NOT NULL,                  -- policy_set | guardrail_profile | quota_profile | model_catalog
  product varchar(64),                          -- NULL = org-wide platform config
  version integer NOT NULL,
  payload jsonb NOT NULL,
  payload_hash varchar(64) NOT NULL,
  published_by varchar(128) NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_published_configs_key_version ON published_configs (org_id, scope, product, version);
CREATE INDEX ix_published_configs_org_scope ON published_configs (org_id, scope, published_at);

-- ── Durable push-notification ledger (satellites ACK after applying) ─────
CREATE TABLE config_notifications (
  config_id uuid NOT NULL REFERENCES published_configs (id) ON DELETE CASCADE,
  satellite_key varchar(64) NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz,
  PRIMARY KEY (config_id, satellite_key)
);

-- ── RLS on the org-scoped table (same policy shape as eng-0002) ──────────
ALTER TABLE published_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON published_configs
  USING (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  )
  WITH CHECK (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  );
