# Deployment Product — Implementation Plan

**Workstream:** product #2 — pipelines, environments, gated rollouts, secrets — as `backend/app/products/deployment/`.
**Binding docs:** [`products/deployment/plan.md`](../../architecture/products/deployment/plan.md) (domain model + build sequence), [product-integration](../../architecture/console/product-integration.md) (manifest example), [ADR-002](../../architecture/decisions/ADR-002-product-taxonomy.md).
**Depends on:** control-plane (manifests, entitlements), partitioning (P-2 quotas, P-3 queue namespaces), L5 agent identities (**already exist** — migration 0015).

## Current state

Nothing exists — new module, new tables. The platform pieces it consumes all exist and are verified: worker queue (priority/DLQ), policy engine (`PolicySet.evaluate_with_results`), metrics/traces plane, L5 agent identities (rotatable, KMS-ready), spend/metering pipeline.

## Steps (from the product plan, implementation-ordered)

**D-1 — Schema (migration 0022, schema `product_deployment` per P-6).** `pipelines`, `pipeline_stages` (gate_policy JSONB, auto_promote), `environments` (tier, pinned_agent_version, quota_ref), `deployments` (status pending→gated→rolling→live→rolled_back→failed, rollout_strategy), `deployment_events` (immutable log), `secrets` (envelope ciphertext + kms_ref — copy migration 0015's pattern). RLS tenant-scoped. *Gate:* migration up/down; import rules.

**D-2 — Module + manifest + entitlement + summary stub.** Register the manifest (the YAML in product-integration is the source); `deployment-usage` entitlement (environments count, retention, canary features); summary provider returns empty KPIs until D-4. *Gate:* card renders as not-owned/trial on `/console/home`; contract owner `deployment`.

**D-3 — Console read APIs.** `/console/deployment/{pipelines,environments,deployments}` list/detail + `deployment_events` log — L1 + `deployment:read` scope; entitlement states per access-model. *Gate:* route tests for each entitlement state; contract re-pin.

**D-4 — The deployment workflow (worker).** `Job(type="deployment.run", namespace="deployment")` (P-3): evaluate stage gates via the **policy engine** (e.g., evaluation-score conditions against the tenant's policy set); snapshot agent config (reads via the public contract with an L3 service token once 06 I-3 exists — until then a platform-internal read with the acting product recorded); update surface bindings; observe rollout via existing metrics; promote/rollback events appended. Runner credentials = **L5 agent identity** minted per tenant (`kind: service`, narrow scopes, 15-min tokens). Every transition audited. *Gate:* workflow unit tests with a stubbed gateway + fake metrics; DLQ path tested.

**D-5 — Canary/rollback + operations pages.** Canary slicing by end-user/surface with guardrail-block + latency read from the metrics plane; alerts (threshold rules → existing alerting); cost view from metering (product tag `deployment`); secrets vault UI endpoints (rotation). *Gate:* canary decision tests; quota buckets per (org → project → environment).

## Files touched

`backend/app/products/deployment/{__init__,models.py,routes_console.py,workflow.py,summary.py}`, `backend/alembic/versions/0022_deployment.py`, `backend/app/products_manifests/deployment.yaml` (activate), `backend/tests/test_product_deployment_*.py`, contract re-pin.

## Rollback

New module behind its manifest registration — unregistering removes routes (P-5) without touching anything else; tables are new-schema-only.
