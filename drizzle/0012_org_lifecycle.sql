-- eng-0012: staged org deletion (the audit's O-2 blocker): request →
-- grace window (cancel-able) → purge. One row per org (the org_id is the
-- primary key — the lifecycle is a state machine over the org).

CREATE TABLE org_deletions (
  org_id varchar(36) PRIMARY KEY,
  requested_by uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'requested', -- requested | cancelled | purged
  scheduled_purge_at timestamptz NOT NULL,
  purged_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_org_deletions_status_purge ON org_deletions (status, scheduled_purge_at);

ALTER TABLE org_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_deletions
  USING (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  )
  WITH CHECK (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  );
