-- eng-0009: org furniture, dense pass.
--
-- Additive ALTERs to the eng-0002 tables (membership heartbeat/suspension,
-- invite resend tracking, project provenance, entitlement seats/source) and
-- the new org furniture: settings, groups (+members junction with
-- denormalized org_id for the RLS shape), and service accounts with a
-- GLOBALLY unique token hash (the AuthGuard resolves `nrv_sa_` tokens by
-- hash before any org context exists — lookup must be unique across orgs).
--
-- RLS follows the eng-0002 policy shape: org_id = current tenant or the
-- documented engine bypass.

-- ── ALTERs (additive, no data rewrite) ──────────────────────────────────────
ALTER TABLE org_memberships ADD COLUMN last_active_at timestamptz;
ALTER TABLE org_memberships ADD COLUMN suspended_at timestamptz;
ALTER TABLE org_memberships ADD COLUMN suspended_by uuid;
CREATE INDEX ix_org_memberships_org_status ON org_memberships (org_id, status);

ALTER TABLE org_invites ADD COLUMN resend_count integer NOT NULL DEFAULT 0;
ALTER TABLE org_invites ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX ix_org_invites_org_email ON org_invites (org_id, email);

ALTER TABLE projects ADD COLUMN created_by uuid;
ALTER TABLE projects ADD COLUMN archived_by uuid;
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE product_entitlements ADD COLUMN seats integer;
ALTER TABLE product_entitlements ADD COLUMN source varchar(32);

-- ── org_settings: one row per org (lazily created) ──────────────────────────
CREATE TABLE org_settings (
  org_id varchar(36) PRIMARY KEY,
  support_email varchar(320),
  default_project_id uuid,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── groups + membership junction ────────────────────────────────────────────
CREATE TABLE org_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  name varchar(128) NOT NULL,
  description varchar(512),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_org_groups_org_name ON org_groups (org_id, name);

CREATE TABLE org_group_members (
  group_id uuid NOT NULL,
  account_id uuid NOT NULL,
  org_id varchar(36) NOT NULL,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX ix_org_group_members_org ON org_group_members (org_id);
CREATE INDEX ix_org_group_members_account ON org_group_members (account_id);

-- ── service accounts (org-owned machine identities) ────────────────────────
CREATE TABLE org_service_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  name varchar(128) NOT NULL,
  description varchar(512),
  status varchar(16) NOT NULL DEFAULT 'active',
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash varchar(64),
  token_prefix varchar(32),
  token_expires_at timestamptz,
  token_last_used_at timestamptz,
  token_last_rotated_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_org_service_accounts_token_hash ON org_service_accounts (token_hash);
CREATE INDEX ix_org_service_accounts_org ON org_service_accounts (org_id);

-- ── RLS: the eng-0002 policy shape on the new tables ────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_settings', 'org_groups', 'org_group_members', 'org_service_accounts'] LOOP
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
