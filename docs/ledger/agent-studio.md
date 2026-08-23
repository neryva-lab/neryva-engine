# Ledger — agent studio product (`modules/agent-studio` — the product registration, engine-side)

**Namespace:** `/console/agent-studio/**` (product console APIs serving the web app's `/studio` area) + the studio manifest/entitlement/card · **Guard:** L1 + membership + `studio:*` scopes + entitlement state · **Spec:** [`dev/agent-studio/plan.md`](../dev/agent-studio/plan.md), [product-integration](../architecture/console/product-integration.md).
**Distinct from [`agent-runtime.md`](agent-runtime.md):** that ledger tracks the Python *satellite* serving `/v1` + `/surfaces`; this one tracks the studio **product furniture inside the engine**. The two meet at the manifest and the metering tag.

**Current state (verified):** the runtime serves everything studio-related; the engine has no studio product registration, entitlement, or card yet.

## Phases

### S-1 — Manifest + card
- [ ] `products_manifests/agent_studio.yaml` registered (faces: control true / runtime **external** — runtime routes declared as the satellite's base URLs per ADR-006); card renders on `/console/home` (owned/trial/none/past_due)
- **Gate:** fake-product-style card test passes for `agent_studio`

### S-2 — Entitlement wiring
- [ ] `studio-team` / `studio-enterprise` plans in `product_entitlements`; `@RequireEntitlement("agent_studio")` on product console routes (403 `entitlement_required` / 402 `past_due`); runtime-side enforcement arrives via policy publishing ([`agent-runtime`](agent-runtime.md) A-4)
- **Gate:** entitlement-state route tests; trial limits flow into engine quotas

### S-3 — Summary provider
- [ ] `GET /console/agent-studio/summary`: conversations (7d) + resolution rate + guardrail blocks (from engine metering + the runtime's observability feed), active agents count; empty-KPI fallback pre-data
- **Gate:** card schema snapshot test; cache_seconds respected

### S-4 — Product console APIs (engine-side org views)
- [ ] Studio org-level views the web app's `/studio` area calls: per-project usage slices ([`billing-metering`](billing-metering.md) B-3), project-scoped key management ([`organizations`](organizations.md) O-1 alterations), evaluations/policies pointers (deep links to runtime-served surfaces until/unless they homestead in the engine)
- **Gate:** contract snapshot (owner `agent_studio`); no duplicate authority with the runtime's routes (proxy map unambiguous)

### S-5 — Metering tag everywhere
- [ ] All studio spend carries `product_tag: agent_studio` (+ `project_id` when keys carry it) — closes with [`agent-runtime`](agent-runtime.md) A-3 and [`billing-metering`](billing-metering.md) B-1
- **Gate:** ledgers slice studio per org × project; rollup only in the consolidated view
