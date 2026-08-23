# Ledger — billing & metering (kernel service + console views)

**Namespace:** spend pipeline (kernel) + usage/billing APIs (console views the web app renders at `/platform/usage`, `/platform/billing`) · **Guard:** L1; billing views owner/admin/billing roles · **Spec:** [`dev/metering/plan.md`](../dev/metering/plan.md), [partitioning §3](../architecture/partitioning.md), [ADR-001 §3](../architecture/decisions/ADR-001-account-model.md).
**Current state (verified):** `spend_events` + aggregation + quota hierarchy `platform>tenant>surface>end_user` exist **in the Python runtime** (satellite-owned until [`agent-runtime`](agent-runtime.md) A-3 hands metering to the engine). Engine-side: nothing yet.

## Phases

> **2026-08-23 (implementation note):** B-1…B-3 + B-5 implemented in `src/modules/billing` (eng-0004, schema `billing`) — items below marked `[~]` until their gates run. B-4 stays `[ ]` (runtime-side dual-write).

### B-1 — Engine metering plane (receiving)
- [~] Ingest API for spend events (satellites push): auth L3/L5, `product_tag` + `project_id` required, idempotent by event id
- [~] Storage: engine-owned `spend_events` (TS migration ownership from creation); quotas extended with **product + project levels** (spec: `dev/partitioning` P-2 — `platform>tenant>product>project>surface>end_user`)
- **Gate:** ingest idempotency tests; quota-level unit tests; unset levels = current behavior (parity test)

### B-2 — Ledgers (per org × product — the ADR-001 rule)
- [~] Ledger aggregation per (org, product) with entitlement-state join; `billing_invoices` (draft|issued|paid|void); **cross-product totals exist only in the read-only rollup API**
- **Gate:** slice tests — a chat subscription never nets against studio usage except in the rollup

### B-3 — Usage/billing APIs
- [~] `/platform`-serving endpoints: per-product/project slices, consolidated rollup, invoices — contract-pinned, role-gated per access-model
- **Gate:** contract snapshot; role matrix tests

### B-4 — Agent-runtime handover dependency
- [ ] When [`agent-runtime`](agent-runtime.md) A-3 flips metering: dual-write window → engine-only; quota enforcement authority moves with it
- **Gate:** reconciliation (engine totals = runtime totals during dual-write) then cutover clean

### B-5 — Per-product chargeback & anomaly
- [~] Chargeback/cost-anomaly jobs (runtime's existing jobs as spec) re-pointed to engine data with product labels
- **Gate:** anomaly alert fires with product label
