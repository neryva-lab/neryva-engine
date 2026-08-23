-- eng-0004: the billing/metering plane (ledger B-1/B-2). Tables live in the
-- dedicated `billing` schema — the Python runtime's public.spend_events
-- stays runtime-owned until the A-3 handover; the engine's ingest lands in
-- ITS OWN tables from creation (ownership map: two systems never own one
-- table). org_id is varchar(36) matching tenants.id — no FK across system
-- boundaries (partitioning §5). RLS per org_id, same policy shape as
-- eng-0002 (transaction-local tenant context + engine-bypass escape hatch).

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE billing.spend_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(160) NOT NULL,
  source varchar(64) NOT NULL,
  org_id varchar(36) NOT NULL,
  product varchar(64) NOT NULL,
  project_id uuid,
  surface varchar(128),
  end_user_id varchar(64),
  kind varchar(32) NOT NULL DEFAULT 'inference',
  model varchar(128),
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: a satellite retrying a push never double-bills.
CREATE UNIQUE INDEX uq_billing_spend_source_event ON billing.spend_events (source, event_id);
CREATE INDEX ix_billing_spend_org_product_time ON billing.spend_events (org_id, product, occurred_at);
CREATE INDEX ix_billing_spend_org_project ON billing.spend_events (org_id, project_id);
CREATE INDEX ix_billing_spend_org_time ON billing.spend_events (org_id, occurred_at);

CREATE TABLE billing.billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  product varchar(64) NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  total_usd numeric(12,2) NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  issued_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_billing_invoices_org_product_period ON billing.billing_invoices (org_id, product, period_start);
CREATE INDEX ix_billing_invoices_org_status ON billing.billing_invoices (org_id, status);

-- Schema-qualified names must be formatted as %I.%I (a single %I would
-- quote "billing.spend_events" as ONE identifier and fail).
DO $$
DECLARE t text; s text; n text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing.spend_events', 'billing.billing_invoices'] LOOP
    s := split_part(t, '.', 1); n := split_part(t, '.', 2);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, n);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', s, n);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I.%I
        USING (
          org_id = current_setting('app.current_tenant', true)
          OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
        )
        WITH CHECK (
          org_id = current_setting('app.current_tenant', true)
          OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
        )
    $p$, s, n);
  END LOOP;
END $$;
