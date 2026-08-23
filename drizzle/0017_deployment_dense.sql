-- eng-0017: deployment product deepening (D-3…D-5 dense pass).
--
-- Environment protection + serving state, stage rollout ladders, persisted
-- run state (crash-safe workflow), git context, secrets governance, and the
-- org settings singleton. All additive — every column carries a default so
-- existing rows keep their meaning (pre-0017 runs read as strategy-default
-- ladders; the workflow resolves them lazily).

-- ── environments: protection rules + live serving state ────────────────────
ALTER TABLE product_deployment.environments
  ADD COLUMN IF NOT EXISTS region varchar(64),
  ADD COLUMN IF NOT EXISTS description varchar(512),
  ADD COLUMN IF NOT EXISTS approval_mode varchar(16) NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS auto_promote integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS concurrency integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_deployed_at timestamptz,
  ADD COLUMN IF NOT EXISTS live_deployment_id uuid,
  ADD COLUMN IF NOT EXISTS live_version varchar(64);

-- Live version bootstrap: an env already pinned is already serving it.
UPDATE product_deployment.environments
  SET live_version = pinned_agent_version
  WHERE pinned_agent_version IS NOT NULL AND live_version IS NULL;

-- ── pipeline stages: names + rollout ladder overrides ──────────────────────
ALTER TABLE product_deployment.pipeline_stages
  ADD COLUMN IF NOT EXISTS name varchar(128),
  ADD COLUMN IF NOT EXISTS rollout_policy jsonb;
CREATE INDEX IF NOT EXISTS ix_deployment_stages_env ON product_deployment.pipeline_stages (org_id, environment_id);

-- ── deployments: frozen ladder, resumable state, git context ───────────────
ALTER TABLE product_deployment.deployments
  ADD COLUMN IF NOT EXISTS ladder jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rollout_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS git_commit varchar(64),
  ADD COLUMN IF NOT EXISTS git_branch varchar(256),
  ADD COLUMN IF NOT EXISTS git_message varchar(512);
CREATE INDEX IF NOT EXISTS ix_deployment_deployments_env ON product_deployment.deployments (org_id, environment_id);

-- ── secrets: governance columns ────────────────────────────────────────────
ALTER TABLE product_deployment.secrets
  ADD COLUMN IF NOT EXISTS preview varchar(24),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotation_interval_days integer,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- ── org settings singleton ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_deployment.deployment_settings (
  org_id varchar(36) PRIMARY KEY,
  default_strategy varchar(16) NOT NULL DEFAULT 'canary',
  default_ladder jsonb NOT NULL DEFAULT '[]'::jsonb,
  auto_rollback integer NOT NULL DEFAULT 1,
  default_canary_weight integer NOT NULL DEFAULT 10,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE product_deployment.deployment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_deployment.deployment_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON product_deployment.deployment_settings;
CREATE POLICY tenant_isolation ON product_deployment.deployment_settings
  USING (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  )
  WITH CHECK (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  );
