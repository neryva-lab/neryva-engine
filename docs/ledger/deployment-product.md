# Ledger — deployment product (`modules/deployment`)

**Namespace:** `/console/deployment/**` + `deployment:` queue namespace · **Guard:** L1 + membership + `deployment:*` scopes + entitlement state · **Spec:** [`dev/deployment/plan.md`](../dev/deployment/plan.md), [product plan](../architecture/products/deployment/plan.md).
**Current state:** nothing — net-new TS module (ADR-005 D2). Platform pieces it consumes: engine queues, engine policy engine (decision-making per ADR-006), L5 agent identities, metering (tag `deployment`). **Note (ADR-006 D4):** if its worker fleet outgrows the engine, it graduates to a capability deployment via the standard contract — an ADR-level act; until then it is an engine module.

## Phases

> **2026-08-23 (implementation note):** D-1…D-5 implemented in `src/modules/deployment` (eng-0005, schema `product_deployment`) — marked `[~]` until gates run. L5 runner minting stays with the handover track (correction C18); the workflow acts as the audited system principal until then.

> **2026-08-24 (deepening, eng-0017):** dense pass over the whole module.
> Rollout ladders are configurable per stage/org (`{weight, soak_seconds,
> manual}` steps — Argo/Vercel/CodeDeploy shapes) and PERSISTED on the run
> row with resumable state (60s reconciler = crash safety). Run controls:
> pause/resume, promote (gate + ladder), cancel, gate reject, instant
> rollback that restores the environment's previous live version.
> Environment protection rules (approval_mode manual, concurrency,
> maintenance) join stage gate policies (env floors approvals at 1).
> Secrets vault: masked previews, expiry + rotation cadence + daily scan
> notifications, versioning, and the L3 runtime-config resolve
> (`engine:config:pull`) — the only plaintext read path, audited per call.
> New surfaces: releases timeline + KPIs, org activity feed, org settings
> singleton, full `/v1/deployments` CI lifecycle, quota reservation at
> trigger, event-log retention per plan. max_pipelines enforced.

### D-1 — Schema
- [~] `pipelines`, `pipeline_stages` (gate_policy), `environments`, `deployments` (status machine), `deployment_events` (immutable), `secrets` (envelope + kms_ref) — engine-owned from creation; RLS; schema `product_deployment`
- **Gate:** migrations clean; boundary rules green

### D-2 — Manifest + entitlement + summary stub
- [~] `deployment-usage` plans (environments count, retention, canary); card renders not-owned/trial on `/console/home`
- **Gate:** fake-product-style card test passes for deployment

### D-3 — Console APIs
- [~] Pipelines/environments/deployments list+detail + events log; 403/402 entitlement semantics
- **Gate:** route tests per entitlement state; contract snapshot (owner `deployment`)

### D-4 — The workflow
- [~] `deployment.run` job on the `deployment:` queue namespace: stage gates evaluated by the **engine policy service**; snapshot agent config (reads the runtime via its public contract, L3 token, acting product recorded); surface binding updates; promote/rollback events — every transition audited
- [~] Runner credentials: L5 agent identities (existing 0015 pattern)
- **Gate:** promote→canary→rollback e2e with stubbed gateway; DLQ path tested

### D-5 — Operations pages
- [~] Canary metrics (from runtime's observability feed), alerts, cost (engine metering, tag `deployment`), secrets vault (rotation)
- **Gate:** canary decision tests; quota buckets per (org→project→environment)
