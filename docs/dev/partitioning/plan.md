# Partitioning — Implementation Plan

**Workstream:** enforce shared-vs-dedicated: import boundaries, quota product/project levels, per-product namespaces, route enforcement.
**Binding docs:** [`partitioning.md`](../../architecture/partitioning.md) (the four tiers + §5 enforcement points), [ADR-003](../../architecture/decisions/ADR-003-backend-topology.md).

## Current state (verified)

- **No import-boundary tooling** exists (no import-linter config in `backend/pyproject.toml`).
- `backend/app/gateway/quota.py`: `QuotaService` with `_LEVELS = ("platform", "tenant", "surface", "end_user")` — **no product or project level** (F4 of the senior review).
- `backend/app/infrastructure/queue/manager.py`: one `QueueManager` (priority/DLQ/scheduled) — no per-product namespacing.
- `backend/app/infrastructure/cache/manager.py`: global `neryva:` prefix; `tenant_runtime.py` namespaces by database URL — no product dimension.
- All tables in the single default schema (per-product Postgres schemas are the documented target layout, not current state).

## Steps

**P-1 — Import-linter contracts + CI (no runtime change).** Add `import-linter` to dev requirements; contracts in `backend/pyproject.toml`: (a) `backend.app.products.*` may import `backend.app.{modules,infrastructure,application,gateway,governance,platform}` but **nothing may import `backend.app.products.*` back**; (b) products never import each other. CI step after ruff. Bootstrap note: `app/products/` doesn't exist until agent-studio lands — the contract is added with a placeholder package so it enforces from day one. *Gate:* CI red on a deliberate violating import in a scratch branch.

**P-2 — Quota levels: product + project.** In `quota.py`: extend `_LEVELS` to `platform > tenant > product > project > surface > end_user`; `QuotaLimits` gains `product_usd`, `project_usd`; reservation paths carry `product_tag` + `project_id` (from spend-event emission points — see [metering](../metering/plan.md) M-1); defaults `0.0` (= unset) so **existing tenants see zero behavior change**. *Gate:* unit tests for the new hierarchy + a no-config parity test; gateway integration test unchanged.

**P-3 — Queue namespaces.** `QueueManager.enqueue` gains an optional `namespace` (default platform); queue keys become `{namespace}:{queue}`; worker pools configurable per namespace (`WORKER_QUEUES` setting) so a product backlog can never starve another (partitioning §2). *Gate:* namespace isolation test (enqueue in `deployment:` never dequeued by platform worker).

**P-4 — Cache + metric namespaces.** Cache manager prefix composition gains the product tag (`neryva:{product}:…`) where caches are product-scoped; gateway/guardrail metrics gain a `product` label at emission points. *Gate:* cache-key unit test; metric cardinality review (bounded product count — registry keys).

**P-5 — Route enforcement (with control-plane C-1).** Route registration consults the manifest registry: any router declaring paths outside a registered manifest's `runtime_routes`/`console.base_route` fails at startup (404-by-construction). *Gate:* startup failure test on an undeclared route.

**P-6 — Per-product Postgres schemas (target layout, executes with agent-studio/deployment module moves).** Per-module SQLAlchemy `MetaData` + `__table_args__ = {"schema": "product_studio"}` for new product tables; Alembic migrations attach schemas (`CREATE SCHEMA IF NOT EXISTS`); platform tables stay in `public`. RLS policies apply identically. *Gate:* migration up/down on all three engines used in tests (sqlite fallback documented — schemas are Postgres-only; sqlite tests use the default schema via dialect-conditional DDL).

## Files touched

`backend/pyproject.toml` (import-linter + contracts), `.github/workflows/ci.yml`, `backend/app/gateway/quota.py`, `backend/app/infrastructure/queue/manager.py`, `backend/app/infrastructure/cache/manager.py`, `backend/app/infrastructure/observability/metrics.py` (label), product module migrations, `backend/tests/test_partitioning_*.py`.

## Rollback

Every step is additive or tooling; P-2 defaults preserve current behavior; P-3/P-4 default to the un-namespaced forms.
