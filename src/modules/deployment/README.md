# deployment (`src/modules/deployment`)

**Purpose:** product #2 (ledger deployment-product D-1…D-5): pipelines,
environments, gated rollouts, instant rollback, and the per-environment
secrets vault — take an agent from draft to production safely. Console-only
product (`consumer: false` per ADR-003 D2).

**Routes:** `/console/deployment/**` (L1 + membership + `deployment:read`-
shaped roles; entitlement semantics per the access-model) · `POST/GET
/v1/deployments` (L2 keys, scope `deployment:operate`) · worker: the
`deployment:default` BullMQ namespace.

**Tables (engine-owned, eng-0005, schema `product_deployment`, RLS per
org_id):** pipelines, pipeline_stages (gate_policy JSONB), environments,
deployments (explicit status machine), deployment_events (append-only run
log), secrets (envelope-encrypted `enc:v1:`, optional kms_ref — plaintext
never persists, never returns through any console API).

**Flag:** `MODULES__DEPLOYMENT_ENABLED` (requires console + billing).

**Semantics:**
- Status machine: `pending → gated → rolling → live`, exits `rolled_back`
  / `failed`; every transition validated against the explicit table,
  appended to the event log, audited — one guarded path for worker AND
  console APIs (approve/rollback race safely; idempotent steps)
- Gates: the engine-side policy seam (D-4) — pure evaluation of
  `{require: all|any, checks[], min_approvals}` against reported metrics;
  unknown metrics fail CLOSED but read as `awaiting` (rollout pauses,
  re-checks with backoff, 2h ceiling); malformed stored policies are
  unsatisfiable, never silent passes
- Canary: 10/50/100 weights, each re-evaluated against reported metrics;
  abort rolls back when the stage says rollback_on_failure
- Metering: every completed run emits a spend event tagged `deployment`
  (day-one rule; runner-time pricing lands with D-5)
- Plan ceilings (max_pipelines/max_environments) enforced at creation from
  the entitlement limits — the trial's "1 pipeline, 2 environments" is
  code, not trust
- Runner credentials: L5 agent identities mint engine-side arrive with the
  handover track (correction C18); the workflow acts as the audited system
  principal `system:deployment-worker` until then

**Public interface:** `DeploymentsService`, `DeploymentWorkflow`
(`schedule()`), `DeploymentSummary`, `PipelinesService`,
`EnvironmentsService`, `SecretsService`.
