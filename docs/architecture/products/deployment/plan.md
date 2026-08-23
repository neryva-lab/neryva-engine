# Product Plan — Neryva Deployment (`deployment`)

**Status:** Plan of record · **Date:** 2026-08-23 · **Register entry:** [ADR-002](../../decisions/ADR-002-product-taxonomy.md) · **Contract:** [console/product-integration.md](../../console/product-integration.md)

## One-paragraph definition

Deployment is product #2: **pipeline, environment, and rollout orchestration for agents** — take an agent built in Agent Studio from draft to production safely: promote versions through environments (dev → staging → prod), run gated rollouts and instant rollbacks, watch infrastructure, logs, alerts, and cost, and keep secrets and compliance posture per environment. It is **console-only** (`consumer: false`): a product does not need a consumer face, and this one deliberately has none (ADR-003 D2 demonstrates exactly this).

## What it is NOT

- Not a CI/CD system for arbitrary code — it orchestrates **agents and their configurations** (prompts, policies, knowledge, model bindings, surfaces).
- Not infrastructure provisioning (no Terrafoam-style cloud management) — it manages **Neryva resources** and their rollout states.
- Not a separate engine: no own identity, no own gateway, no direct provider access.

## Core domain model (new schemas, owned by the product)

```
pipelines          id, org_id, project_id, name, source_agent, stages[]
pipeline_stages    id, pipeline_id, env_id, gate_policy (checks before promotion),
                   auto_promote, rollback_on_failure
environments       id, org_id, name (dev|staging|prod|custom), tier, quota_ref,
                   pinned_agent_version, guardrail_profile
deployments        id, pipeline_id, env_id, agent_version, status
                   (pending→gated→rolling→live→rolled_back→failed), triggered_by,
                   rollout_strategy (all|canary pct|blue-green), started_at
deployment_events  id, deployment_id, kind, payload, at        (immutable log)
secrets            id, env_id, key, value_ciphertext, kms_ref, rotated_at
                   (envelope pattern per migration 0015 — never plaintext)
```

All tables inherit tenant RLS; all spend emitted with `product_tag: deployment`.

## Console pages (from the manifest)

- **Delivery:** Pipelines (list + builder), Deployments (run view: stage progress, gates, canary metrics), Environments (state, pinned versions, quotas).
- **Operations:** Infrastructure (what surfaces/runtimes serve each env), Logs (deployment_events + linked platform traces), Alerts (threshold rules → existing alerting), Cost (per-env spend from the metering plane), Secrets (envelope-encrypted, rotation), Compliance (per-env policy/guardrail posture — read from the governance plane).

## Runtime plane (how work actually executes)

- `POST /v1/deployments` + friends — deployment API (L2 keys with `deployment:operate` scope).
- **Worker jobs** on the platform queue: a "deployment run" is a worker workflow (evaluate gates → snapshot agent config → update surface bindings → observe rollout metrics → promote/rollback). Runner credentials are **L5 agent identities** (`kind: service`, narrow scopes, 15-min tokens) — the platform's existing non-human identity design is exactly this product's runner model.
- Rollout observation reads the existing metrics/trace plane (gateway latency, guardrail block rates per canary slice) — no new telemetry.
- **Gate checks** evaluate against the platform policy engine (e.g. "evaluations score ≥ X on the staging suite before promoting to prod") — deployments are policy-governed actions like everything else.

## Relationship to Agent Studio (the cross-product seam, done correctly)

Deployment does **not** import Studio. It reads agent versions through the public contract (an L3 service token with `studio:read` — the acting product is recorded in the audit chain). Studio's console may *link* to a deployment view ("this agent is live in prod via pipeline X") using the same mechanism in reverse. This is the enforced pattern (product-integration.md) proving two products interoperate without coupling.

## Entitlements

`deployment-usage` — metered by deployment runs + active environments (plans scale: environments count, retention days, canary features). Trial: 1 pipeline, 2 environments, 30 days. Spend caps and quotas ride the quota engine (extended with product/project levels per [partitioning.md](../../partitioning.md)) per (org → project).

## Build sequence (module-scoped, nothing platform-wide)

1. Schemas + RLS + manifest + entitlement + summary provider (contract artifacts).
2. Console read pages (pipelines/environments/deployments lists) over the schemas.
3. Deployment worker workflow with L5 runner identities + gate evaluation.
4. Canary/rollback strategies, alerts, cost views.
5. Secrets vault (envelope encryption) + compliance posture page.

## Summary card (contract example)

KPIs: active pipelines, deploys this week (7d), rollback rate, environments near quota — each derived from its own tables + the metering plane.
