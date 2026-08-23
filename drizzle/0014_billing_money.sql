-- eng-0014: the billing money extensions (gaps B-2/B-3/B-5/B-7):
-- credits & grant applications, budgets with threshold alerts, invoice
-- line items, and adjustments. All org-scoped (RLS per org_id, same policy
-- shape as eng-0002); money columns numeric, sums in SQL.

CREATE TABLE billing_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  kind varchar(32) NOT NULL DEFAULT 'grant',   -- grant | trial | promotional | purchase
  note varchar(256),
  amount_usd numeric(12,6) NOT NULL,
  remaining_usd numeric(12,6) NOT NULL,
  granted_by varchar(128) NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_credits_org ON billing_credits (org_id, expires_at);

CREATE TABLE billing_credit_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  applied_usd numeric(12,6) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_credit_apps_invoice ON billing_credit_applications (invoice_id);

CREATE TABLE billing_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  product varchar(64),
  project_id uuid,
  name varchar(128) NOT NULL DEFAULT 'Monthly budget',
  monthly_usd numeric(12,2) NOT NULL,
  thresholds jsonb NOT NULL DEFAULT '[50,80,100]'::jsonb,
  notified_percent integer NOT NULL DEFAULT 0,
  notified_cycle varchar(7),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_budgets_org ON billing_budgets (org_id);

CREATE TABLE billing_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  kind varchar(32) NOT NULL,
  model varchar(128),
  events integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  unit_price_note varchar(128),
  amount_usd numeric(12,6) NOT NULL
);
CREATE INDEX ix_billing_invoice_lines_invoice ON billing_invoice_lines (invoice_id);

CREATE TABLE billing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  product varchar(64) NOT NULL,
  kind varchar(32) NOT NULL,                  -- credit_note | debit_note | support_credit
  amount_usd numeric(12,6) NOT NULL,          -- signed: negative reduces the next invoice
  reason varchar(1024) NOT NULL,
  applied_invoice_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_adjustments_org_product ON billing_adjustments (org_id, product);
-- One consumption per adjustment: a UNIQUE on a nullable column allows
-- multiple NULLs (pending) and exactly one non-null claim.
CREATE UNIQUE INDEX uq_billing_adjustments_applied ON billing_adjustments (applied_invoice_id) WHERE applied_invoice_id IS NOT NULL;

-- RLS on the org-scoped tables (billing schema, same %I.%I discipline).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_credits', 'billing_credit_applications', 'billing_budgets', 'billing_invoice_lines', 'billing_adjustments'] LOOP
    -- credit_applications and invoice_lines carry no org_id (they are
    -- invoice-bound children); the parent tables isolate.
    IF t IN ('billing_credit_applications', 'billing_invoice_lines') THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', 'billing', t);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', 'billing', t);
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
    $p$, 'billing', t);
  END LOOP;
END $$;
