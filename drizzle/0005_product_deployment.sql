-- eng-0005: the deployment product (D-1) in its own schema `product_deployment`
-- (partitioning P-6: per-product Postgres schemas). org_id varchar(36) matches
-- tenants.id — reference by id, no cross-system FK. RLS per org_id with the
-- eng-0002 policy shape (transaction-local tenant context + engine bypass).

CREATE SCHEMA IF NOT EXISTS product_deployment;

CREATE TABLE product_deployment.pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  project_id uuid,
  name varchar(128) NOT NULL,
  description varchar(512),
  source_agent varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_deployment_pipelines_org_name ON product_deployment.pipelines (org_id, name);
CREATE INDEX ix_deployment_pipelines_org ON product_deployment.pipelines (org_id);

CREATE TABLE product_deployment.environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  project_id uuid,
  name varchar(64) NOT NULL,
  tier varchar(32) NOT NULL DEFAULT 'shared',
  pinned_agent_version varchar(64),
  guardrail_profile varchar(64),
  quota_ref varchar(64),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_deployment_environments_org_name ON product_deployment.environments (org_id, name);

CREATE TABLE product_deployment.pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES product_deployment.pipelines (id) ON DELETE CASCADE,
  org_id varchar(36) NOT NULL,
  environment_id uuid NOT NULL REFERENCES product_deployment.environments (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  gate_policy jsonb NOT NULL DEFAULT '{"require":"all","checks":[],"min_approvals":0}'::jsonb,
  auto_promote integer NOT NULL DEFAULT 0,
  rollback_on_failure integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_deployment_stages_pipeline_position ON product_deployment.pipeline_stages (pipeline_id, position);
CREATE INDEX ix_deployment_stages_org ON product_deployment.pipeline_stages (org_id);

CREATE TABLE product_deployment.deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES product_deployment.pipelines (id) ON DELETE RESTRICT,
  stage_id uuid NOT NULL REFERENCES product_deployment.pipeline_stages (id) ON DELETE RESTRICT,
  environment_id uuid NOT NULL REFERENCES product_deployment.environments (id) ON DELETE RESTRICT,
  agent_version varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  strategy varchar(16) NOT NULL DEFAULT 'all',
  canary_percent integer,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  triggered_by varchar(128),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_deployment_deployments_org_created ON product_deployment.deployments (org_id, created_at);
CREATE INDEX ix_deployment_deployments_pipeline ON product_deployment.deployments (pipeline_id);
CREATE INDEX ix_deployment_deployments_status ON product_deployment.deployments (org_id, status);

-- The immutable run log: append-only by construction (code has no update
-- path); org_id is denormalized so RLS isolates it like everything else.
CREATE TABLE product_deployment.deployment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  deployment_id uuid NOT NULL REFERENCES product_deployment.deployments (id) ON DELETE CASCADE,
  kind varchar(48) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_deployment_events_deployment_time ON product_deployment.deployment_events (deployment_id, created_at);
CREATE INDEX ix_deployment_events_org ON product_deployment.deployment_events (org_id, created_at);

CREATE TABLE product_deployment.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  environment_id uuid NOT NULL REFERENCES product_deployment.environments (id) ON DELETE CASCADE,
  key varchar(128) NOT NULL,
  value_ciphertext text NOT NULL,
  kms_ref varchar(256),
  rotated_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_deployment_secrets_env_key ON product_deployment.secrets (environment_id, key);
CREATE INDEX ix_deployment_secrets_org ON product_deployment.secrets (org_id);

-- Schema-qualified names must be formatted as %I.%I (a single %I would
-- quote "product_deployment.pipelines" as ONE identifier and fail).
DO $$
DECLARE t text; s text; n text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'product_deployment.pipelines',
    'product_deployment.environments',
    'product_deployment.pipeline_stages',
    'product_deployment.deployments',
    'product_deployment.deployment_events',
    'product_deployment.secrets'
  ] LOOP
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
