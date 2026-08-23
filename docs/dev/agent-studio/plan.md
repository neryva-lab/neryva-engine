# Agent Studio Module — Implementation Plan

**Workstream:** the studio backend becomes a registered product module (`backend/app/products/agent_studio/`) with manifest, entitlement, summary provider, and metering tag.
**Binding docs:** [`products/agent-studio/plan.md`](../../../architecture/products/agent-studio/plan.md) (the product plan), [product-integration](../../../architecture/console/product-integration.md), [ADR-003](../../../architecture/decisions/ADR-003-backend-topology.md) (D1 modules).
**Depends on:** partitioning P-1/P-2 (boundaries + quota levels), control-plane C-1/C-3 (manifest + summaries).

## Current state (verified)

The studio capabilities live as platform-shaped code: session engine (`app/session/`), threads (`app/infrastructure/db/threads.py`), conversations routes (`app/api/routes/conversations.py`, 3604 lines), surfaces + end-user tokens, prompts/tools/models admin views, memory, compaction. Nothing is tagged as a product; spend events carry no product dimension.

## Target

`backend/app/products/agent_studio/` owning the studio product surface (routes + views + summary), with the **runtime engine (threads, gateway calls, guardrails) staying platform-side** (products are thin per the inheritance list) — the module reorganization is about **route ownership, tagging, and entitlement**, not rewriting the engine.

## Steps

**S-1 — Module skeleton + manifest (additive).** Create `app/products/agent_studio/` with `manifest = load from backend/app/products_manifests/agent_studio.yaml` (C-1). No moves yet. *Gate:* import rules green (P-1); app boots.

**S-2 — Route ownership move.** Move (git mv, imports updated) the product-facing route modules into the package: `conversations.py`, surface routes, openai-compat mounting, prompts/tools/models admin views — public paths **unchanged** (`/v1/**`, `/surfaces/**`, admin paths identical), routers now declared under the product's registered routes (P-5 enforces). Platform-side routers (org/identity/usage/governance) stay. *Gate:* OpenAPI export **byte-identical path set** (103) with owners now `agent_studio` on product paths (C-2 re-tag); all existing route tests green.

**S-3 — Metering tag.** Spend-event emission points (gateway/spend pipeline) gain `product_tag="agent_studio"` (+ `project_id` when keys carry it — O-1); `SpendEventModel` gains the columns (migration 0021 — with [metering](../metering/plan.md) M-1 if executed together). *Gate:* spend rows tagged; quota reservations route through P-2's product level.

**S-4 — Entitlement + summary.** Register `studio-team`/`studio-enterprise` plans (organizations O-2); `require_entitlement("agent_studio")` wraps product routes (403/402 semantics per access-model); `GET /console/agent-studio/summary` returns the card (conversations 7d from spend/threads aggregates, resolution rate + guardrail blocks from metrics, active agents count) — the C-3 schema. *Gate:* card renders for trial/active/past_due states; contract re-pin.

## Explicitly NOT moving

The session engine, thread store, gateway, guardrails, policy engine, memory/compaction — platform services the product *calls* (the product plan says the same: "a reorganization of existing code, not new development" at the route/view layer).

## Files touched

`backend/app/products/agent_studio/{__init__,routes.py,summary.py}`, git-mv'd route modules, `backend/app/infrastructure/db/models.py` (SpendEvent columns), `backend/alembic/versions/0021_studio_tagging.py`, `backend/tests/test_product_studio_*.py`, contract re-pin.

## Rollback

S-1/S-4 additive; S-2 is a pure move (revert = move back); S-3 columns nullable-defaulted.
