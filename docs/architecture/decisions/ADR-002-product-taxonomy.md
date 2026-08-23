# ADR-002 — Product Taxonomy: What Is a Product and What Is Not

**Status:** Accepted · **Date:** 2026-08-23
**Decides:** the official product register. Today the website implicitly defines four "products" via hardcoded page trees (with naming drift); this ADR replaces that with one deliberate register held by the platform.

## The test

An offering is a **product** if it satisfies **all** of:

1. **Distinct value proposition** — a customer could want it without wanting the others.
2. **Own entitlement** — its own plans, trial, and limits in `product_entitlements` (it can be bought, suspended, and expire independently).
3. **Own surfaces** — at least one console surface (management pages) or runtime surface (end-user pages/API) that belongs to it.
4. **Own data** — schemas that belong to no other product.

If it fails any of these it is a **packaging view** (a way to market/sell an existing product) or a **feature**, and it must not create new backend topology.

## The register

| Product key | Offering | Status | Surfaces | Entitlement |
|---|---|---|---|---|
| `agent_studio` | **Neryva Agent Studio** — build, govern, and run agents (console pages + embeddable widget + OpenAI-compatible API) | **Product #1 — exists** (the current studio platform surfaces) | Console: dashboard, agents, knowledge, policies, evaluations, usage, settings. Runtime: widget (`L4` end-user tokens), OpenAI-compat API (`L2` keys), webhooks | team/enterprise plans |
| `deployment` | **Neryva Deployment** — pipelines, environments, infrastructure, and rollout orchestration for agents | **Product #2 — planned** (the intended UX exists as the website's demo data; the backend is a new bounded context) | Console only: pipelines, deployments, environments, infrastructure, logs, alerts, cost, secrets, compliance. Runtime: deployment API + worker jobs (`L5` agent identities) — **no consumer surface**, and that is fine: a product does not need a consumer face | usage-based plans |
| `chat` | **Neryva Chat** (working name) — the consumer product | **Product #3 — future, trigger-gated** (final_analysis 06 §9A) | Consumer web/app (personal context, ADR-001), anonymous→registered upgrade | free/subscription tiers |

**Everything else on the website is a packaging view, not a product:**

- Website "Enterprise AI Assistant" / `ai_enterprised` → a **vertical packaging view of Agent Studio** (same product, enterprise plan + solution content). Fix the naming drift in the website when convenient; it has no backend meaning.
- Website "AI Efficiency Deployment" / `ai_efficiency_deployment` → a **marketing angle on Deployment**.
- Website `agent_studio_chat` demo pack → the **widget/Chat surface of Agent Studio** (and, later, a preview of product #3).

## Consequences

- The **console** shows exactly three products ever (until a new one passes the test), each in whatever entitlement state the org holds (`console/overview.md`) — including products the org has not purchased, shown as available.
- **Commerce is per product** (ADR-001): Studio usage, Deployment usage, and a Chat subscription are separate ledgers.
- **One product may appear under several names in marketing** — marketing owns naming per audience; the platform register owns identity. The register's `key` is the join key everywhere (entitlements, metering tags, routes, manifests).
- Adding product #4+ requires this register to be amended (an ADR) — not just a marketing page or a console route. That is deliberate friction: the register is the company's product strategy in one table.
- The website's per-product page trees remain **marketing artifacts only**; they never again imply backend structure (analysis of 2026-08-23: the demo-console drift problem is a symptom of violating this rule).

## Relationship to other ADRs

Identity across all three products → [ADR-001](ADR-001-account-model.md). Where each product's code runs and which API faces it uses → [ADR-003](ADR-003-backend-topology.md). How a product registers into the console → [`console/product-integration.md`](../console/product-integration.md).
