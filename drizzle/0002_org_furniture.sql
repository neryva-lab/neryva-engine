-- eng-0002: org furniture (memberships, invites, projects, entitlements)
-- with RLS per org_id. org_id is varchar(36) matching the Python-owned
-- tenants.id — NO foreign key across system boundaries (partitioning §5).
--
-- RLS design (correction C16): tenant context is transaction-local
-- (set_config('app.current_tenant', ..., true)); the engine-bypass setting
-- admits the documented administrative paths (cross-org account lookups,
-- invite redemption before membership). FORCE applies the policy even to
-- the table owner.

CREATE TABLE org_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  org_id varchar(36) NOT NULL,
  role varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  invited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_org_memberships_account_org ON org_memberships (account_id, org_id);
CREATE INDEX ix_org_memberships_org ON org_memberships (org_id);

CREATE TABLE org_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  email varchar(320) NOT NULL,
  role varchar(16) NOT NULL,
  token_hash varchar(64) NOT NULL,
  invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_org_invites_org ON org_invites (org_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  name varchar(128) NOT NULL,
  description varchar(512),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_projects_org_name ON projects (org_id, name);

CREATE TABLE product_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  product varchar(64) NOT NULL,
  plan varchar(64) NOT NULL,
  status varchar(16) NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_product_entitlements_org_product ON product_entitlements (org_id, product);

-- ── RLS: one policy shape for all four tables ─────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_memberships', 'org_invites', 'projects', 'product_entitlements'] LOOP
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
