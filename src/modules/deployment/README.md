# deployment (`src/modules/deployment`)

**Purpose:** product #2 (ledger deployment-product D-1…D-5): pipelines,
environments, gated rollouts with configurable canary ladders, instant
rollback, the per-environment secrets vault, and the releases timeline —
take an agent from draft to production safely. Console-anchored product
(`consumer: false` per ADR-003 D2) with a full CI-grade runtime API.

**Routes:**
- `/console/deployment/**` — L1 control surface (pipelines, environments,
  deployments + run controls, releases, activity, settings, cost, secrets)
- `/v1/deployments/**` — L2 runtime surface (scope `deployment:operate`):
  create, list, status (+progress), events, metrics, promote, rollback
- `/internal/deployments/:id/runtime-config` — L3 service plane (scope
  `engine:config:pull`, the connection contract's config seam): the serving
  runtime's ONE-CALL bundle — frozen snapshot + environment + decrypted
  secret bundle (audited per resolve, `last_used_at` bumped)
- Worker: the `deployment:default` BullMQ namespace (run steps + the
  reconcile/retention/secrets-scan rhythms)

**Tables (engine-owned, eng-0005 + eng-0017, schema `product_deployment`,
RLS per org_id):** pipelines, pipeline_stages (gate_policy + rollout_policy
JSONB), environments (protection rules + live serving state), deployments
(explicit status machine + frozen ladder + resumable rollout_state + git
context), deployment_events (append-only run log), secrets (envelope-
encrypted `enc:v1:`, masked preview, rotation governance, versioning),
deployment_settings (org singleton).

**Flag:** `MODULES__DEPLOYMENT_ENABLED` (requires console + billing +
organizations).

**Semantics:**
- Status machine: `pending → gated → rolling → live`, exits `rolled_back`
  / `failed`; every transition validated against the explicit table,
  appended to the event log, audited — one guarded path for worker AND
  console/runtime APIs (approve/rollback race safely; idempotent steps)
- Statelessness rule: the run's ONLY memory is the row (frozen `ladder` +
  `rollout_state`); job payloads carry no state. A Redis flush stalls a
  tick, never loses a run — the 60s reconciler re-enqueues stalled rows
- Rollout ladders (rollout.ts): ordered `{weight, soak_seconds, manual}`
  steps frozen at trigger (stage override > org default > strategy
  built-in; canary/linear/blue_green/all). Soak windows bake each weight in
  ≤60s WATCHDOG slices — a hard gate failure mid-soak aborts at most 60s
  late (CodeDeploy alarm semantics); `manual: true` steps are indefinite
  human gates (promote advances); weights always end at 100
- Gates: pure evaluation of `{require: all|any, checks[], min_approvals}`
  against reported metrics; unknown metrics fail CLOSED but read as
  `awaiting` (2h ceiling) — waiting on APPROVALS never times out (humans
  are not metrics); malformed stored policies are unsatisfiable, never
  silent passes. Environment `approval_mode: manual` floors approvals at 1
  (the stage can only raise the bar)
- Run controls: pause/resume (traffic holds at current weight), promote
  (gate approval / ladder skip), retry (redeploy a failed/rolled-back run
  with its exact inputs — history never rewritten), cancel (pending/gated
  fail; rolling rolls back), reject (reviewed gate deny), instant rollback
  — which RESTORES the environment's previous live version (rollbacks are
  only real when serving traffic follows them), and pipeline-level promote
  (one click: the highest live stage's version into the next stage, full
  governance)
- Concurrency: one active run per stage; per-environment `concurrency`
  (default 1, Vercel-style); maintenance-mode environments block triggers
- Auto-promote: a finished stage with `auto_promote` chains the next stage
  (forward-only; cycles structurally impossible)
- Secrets: console sees metadata + write-time-derived masked preview ONLY
  (plaintext never leaves the vault except via the L3 resolve); expiry +
  rotation cadence drive the daily scan (notifications to owner/admin/
  developer); `version` counts overwrites
- Metering: every run reserves quota at trigger (plan caps enforced at
  entry) and emits a spend event tagged `deployment` on completion
- Retention: plan `retention_days` purges the EVENT log daily (run rows
  are permanent history)
- Plan ceilings (max_pipelines/max_environments) enforced at creation from
  the entitlement limits — the trial's "1 pipeline, 2 environments" is
  code, not trust; `limits.canary === false` downgrades slicing strategies
- Runner credentials: L5 agent identities mint engine-side arrive with the
  handover track (correction C18); the workflow acts as the audited system
  principal `system:deployment-worker` until then

**Events (webhooks fan these out automatically):** `deployment.completed`
/ `deployment.failed` / `deployment.rolled_back` on the engine bus;
approval requests and secret-expiry warnings notify in-app via the
notifications module.

**Public interface:** `DeploymentsService`, `DeploymentWorkflow`
(`schedule()`, `runStep()`), `DeploymentWorker`, `DeploymentSummary`,
`PipelinesService`, `EnvironmentsService`, `SecretsService`,
`SettingsService`, `ReleasesService`.

**Roadmap (explicit non-goals for this module):** experiments/
champion-challenger analytics (a separate insight surface), infrastructure/
network/scaling views (satellite observability owns them — the console
renders them from the runtime's feeds), and alert-rule CRUD (the platform
alerting module). Secrets version HISTORY (values are never recoverable by
design — only the count is kept).
