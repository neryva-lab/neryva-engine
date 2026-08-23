-- eng-0006: agent-studio key bindings (S-4). The key ROWS stay Python-owned
-- (api_keys); the BINDING to a project is engine-owned from creation — one
-- authority per fact. Reference-by-id: api_key_id → api_keys.id (varchar36,
-- no FK), project_id → projects.id (uuid, validated in the service).

CREATE TABLE studio_project_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(36) NOT NULL,
  api_key_id varchar(36) NOT NULL,
  project_id uuid NOT NULL,
  bound_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_studio_project_keys_key ON studio_project_keys (org_id, api_key_id);
CREATE INDEX ix_studio_project_keys_project ON studio_project_keys (org_id, project_id);

ALTER TABLE studio_project_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_project_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON studio_project_keys
  USING (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  )
  WITH CHECK (
    org_id = current_setting('app.current_tenant', true)
    OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on'
  );
