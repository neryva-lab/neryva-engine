# Metering & Ledgers — Implementation Plan

**Workstream:** the product/project dimensions on spend, per-(org × product) billing ledgers, and the consolidated usage view.
**Binding docs:** [partitioning.md](../../../architecture/partitioning.md) §3 (billing separation), [ADR-001](../../../architecture/decisions/ADR-001-account-model.md) §3, [`console/overview.md`](../../../architecture/console/overview.md) (usage/billing pages).
**Depends on:** partitioning P-2 (quota levels), agent-studio S-3 (first tagged emitter).

## Current state (verified)

- `SpendEventModel` + `SpendEventRepository` (write-through primary, replica-routed reads — OPT-8) with aggregation (`aggregate`, `list_filtered`).
- Usage routes (`app/api/routes/usage.py`) slice by tenant/time; **no product or project dimension**; no ledger concept; chargeback exists per tenant only.

## Target

Every spend event carries `product_tag` + optional `project_id`; **ledgers are per (org × product)** (independent states, invoices, payment methods per partitioning §3 — a chat subscription never nets against studio usage); one read-only consolidated rollup at org level; payment-provider integration is explicitly out of scope (ledger + invoice records only, until a billing provider is chosen).

## Steps

**M-1 — Dimensions (migration 0021, shared with agent-studio S-3).** `spend_events + product_tag (NOT NULL default 'agent_studio' … but see backfill), project_id NULL`; backfill tags existing rows to `agent_studio` (today's only emitter). Repositories accept product/project filters. *Gate:* backfill idempotent; existing usage outputs unchanged when filtered to `agent_studio`.

**M-2 — Quota wiring.** Reservations route through P-2's product/project levels using the event dimensions (enforcement at gateway call time — the existing reservation flow gains the two keys). *Gate:* quota tests per level; platform-default parity test (unset levels = current behavior).

**M-3 — Ledger aggregation + API.** `LedgerView` built on `SpendEventRepository.aggregate` grouped by (org, product): period totals, entitlement state join (O-2), invoice records table (`billing_invoices` — org, product, period, status draft|issued|paid|void; migration 0021). Routes: `/platform/usage` (per product/project slices + consolidated rollup — the one place totals cross products, read-only), `/platform/billing` (per-ledger views + invoices; owner/billing role per access-model). *Gate:* slice tests — **cross-product totals appear only in the rollup endpoint** (partitioning rule); contract re-pin (owner `platform`).

**M-4 — Chargeback + anomaly per product.** Existing chargeback/cost-anomaly jobs (ops) gain the product dimension for their reports/alerts. *Gate:* anomaly alert fires with product label.

## Files touched

`backend/app/infrastructure/db/{models.py,repositories.py}`, `backend/alembic/versions/0021_metering.py` (coordinated with S-3), `backend/app/api/routes/{usage,billing}.py`, `backend/app/gateway/quota.py` (wiring), `backend/tests/test_metering_*.py`, contract re-pin.

## Rollback

Columns nullable/defaulted; aggregation additive; no existing tenant-visible output changes without the new filters.
