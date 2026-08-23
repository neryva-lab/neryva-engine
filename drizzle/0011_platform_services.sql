-- eng-0011: platform services (the audit's P-1/P-2/P-3 + X-1 + B-1 trust
-- fix): outbound webhooks (+ deliveries), notifications, the durable
-- revocation log, staff impersonation records, and the billing price
-- catalog. Org-scoped tables carry the eng-0002 RLS shape; platform-plane
-- tables (notifications, revocations, impersonations, price catalog) have
-- no RLS — the engine is the only writer and reads are explicitly filtered.

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  url text NOT NULL,
  secret_envelope text NOT NULL,
  description varchar(256),
  status varchar(16) NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_webhooks_org ON webhooks (org_id, status);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  webhook_id uuid NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event_type varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error varchar(512),
  response_status integer,
  delivered_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_webhook_deliveries_org_created ON webhook_deliveries (org_id, created_at);
CREATE INDEX ix_webhook_deliveries_pending ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX ix_webhook_deliveries_webhook ON webhook_deliveries (webhook_id, created_at);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  org_id varchar(36),
  kind varchar(64) NOT NULL,
  severity varchar(8) NOT NULL DEFAULT 'info',
  title varchar(160) NOT NULL,
  body varchar(1024) NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_account_created ON notifications (account_id, created_at);
CREATE INDEX ix_notifications_org ON notifications (org_id, created_at);

CREATE TABLE revocation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(16) NOT NULL,                -- session | account_all | key
  subject_id varchar(128) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_revocation_events_occurred ON revocation_events (occurred_at, id);

CREATE TABLE staff_impersonations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_account_id uuid NOT NULL,
  target_account_id uuid NOT NULL,
  org_id varchar(36),
  reason varchar(512) NOT NULL,
  session_sid varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_staff_impersonations_active ON staff_impersonations (revoked_at, expires_at);
CREATE INDEX ix_staff_impersonations_staff ON staff_impersonations (staff_account_id, created_at);

-- The platform price catalog (B-1 trust fix): effective-windowed versions.
CREATE TABLE billing.price_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product varchar(64) NOT NULL,
  kind varchar(32) NOT NULL,
  model varchar(128),                       -- NULL = default row for the slot
  price_per_million_input_usd numeric(12,6),
  price_per_million_output_usd numeric(12,6),
  price_per_event_usd numeric(12,6),
  currency varchar(3) NOT NULL DEFAULT 'USD',
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  note varchar(256),
  created_by varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_price_catalog_slot ON billing.price_catalog (product, kind, model, effective_from);
CREATE INDEX ix_price_catalog_lookup ON billing.price_catalog (product, kind, model, effective_from);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhooks', 'webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          org_id = current_setting('app.current_tenant', true)
          OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
        )
        WITH CHECK (
          org_id = current_setting('app.current_tenant', true)
          OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
        )
    $p$, t);
  END LOOP;
END $$;
