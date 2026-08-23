# ADR-003 — Backend Topology: One Engine, Two API Faces, Products as Registered Modules

**Status:** Accepted (Amended by [ADR-004](ADR-004-frontend-portal-corporate.md), [ADR-005](ADR-005-engine-typescript-nestjs.md), and [ADR-006](ADR-006-engine-core-capabilities.md)) · **Date:** 2026-08-23
**Decides:** the question *"we have two architectures on the backend — the normal-customer backend and the console/platform backend — where should the Deployment product be, and how are products allowed access to each architecture?"*
**Amendments:**
- **ADR-004:** Corporate backend is absorbed into the engine's `corporate` module (`neryva_backend` retired); single web app (`neryva-website`).
- **ADR-005 & ADR-006:** The engine core is TypeScript on NestJS (core logic: identity, tenancy, billing, control plane, corporate, governance). Heavy workloads are **Capability Deployments (Satellites)** connecting via the 4-part connection contract (the existing Python runtime is `agent-runtime`).

## The reframing (the decision hiding inside the question)

There are not two engines. Splitting into a "consumer backend" and a "console backend" as separate systems would duplicate tenancy, identity, guardrails, policy, gateway, and metering — the exact failure mode final_analysis 05 §5 warns about. What the market actually runs (OpenAI, Anthropic, Google, Stripe, Kubernetes) is **one platform engine with two API faces**:

- **Control plane** (console APIs) — who configures and observes: org humans via the console UI, and customer IT via the admin API. Identity: L1 console sessions (email code / password / passkey, step-up MFA for privileged acts).
- **Runtime plane** (public APIs) — who uses the product at runtime: consumer/anonymous users via surfaces (L4 tokens), customer programs (L2 API keys / L3 service tokens), agents and tools (L5 identities). This is the OpenAI-compatible API, surfaces/widget endpoints, webhooks, and future product runtimes.

Both faces are the **same deployable** (today: `neryva_studio/backend`), the same database, the same governance, the same audit chain. They differ by route group, token layer, and permission model — a discipline the codebase already has (`X-API-Key` vs operator sessions vs end-user tokens are already separated by prefix and verification path).

## The topology

```
                    CORPORATE PLANE (separate, unchanged)
                    neryva.com website + neryva_backend (CMS + website accounts)

┌────────────────────────────────────────────────────────────────────┐
│                 NERYVA PLATFORM — ONE ENGINE                        │
│                                                                    │
│  CONTROL PLANE (console APIs)          RUNTIME PLANE (public APIs) │
│  /console/**                           /v1/** (OpenAI-compat),     │
│  orgs, members, invites, projects,     /surfaces/** (widget, L4),  │
│  entitlements, product manifests,      /webhooks, admin API        │
│  billing views, product summaries                                   │
│              │                                    │                │
│              │        PRODUCT MODULES (bounded contexts)           │
│              ├─── app/products/agent_studio   ←─ studio product    │
│              ├─── app/products/deployment    ←─ deployment product │
│              └─── (future) products/chat      ←─ consumer product  │
│                                                                    │
│  Platform services every product inherits: identity (L1–L5),      │
│  tenancy/RLS, LLM gateway, guardrail stack, policy engine,        │
│  worker/queue, metering/spend, observability, audit chain         │
└────────────────────────────────────────────────────────────────────┘
```

## Decisions

**D1 — Products are bounded-context modules inside the platform, not side-by-side backends.** `app/products/agent_studio/` and `app/products/deployment/` own their schemas, routes, and workers. They import platform services (identity, gateway, guardrails, metering) and **nothing imports them** except their own route mounts. This is the same import-boundary discipline as final_analysis 05 Phase 1, one level down. Modules graduate to separate deployables only on the extraction triggers already defined (second team owning them, independent scaling need) — the module boundary makes that move mechanical.

**D2 — Each product declares which faces it uses.** The product manifest (see `console/product-integration.md`) carries a `faces` field:
- `agent_studio`: control (console pages) + runtime (widget/surfaces, OpenAI-compat API under its product tag).
- `deployment`: control (console pages) + runtime (deployment API + worker jobs) — **no consumer surface**.
- `chat` (future): **consumer** (a Neryva-operated end-user app, personal context) + a thin **control** face (org seats/billing card in the console); no **runtime** face initially (it owns no public API routes — its module serves its own app).
The three face values mean: **control** = console management pages; **runtime** = public API routes the product owns for customers/programs/end-user surfaces; **consumer** = a first-party end-user app in the personal context.
The platform enforces the declaration: a module with no runtime face gets no public routes; a module with no control face gets no console nav.

**D3 — Access between faces is token-layer discipline, already built.** Console pages call control-plane APIs with L1 sessions; widget/chat traffic arrives on L4 tokens; customer programs on L2 keys; deploy runners on L5 identities. A token from one layer is never accepted on another (final_analysis 06 §6 rule 1). "How is a product allowed access to general vs console architecture" is therefore answered by the manifest + token layers — there is no second permission system to invent.

**D4 — Deployment lives in the platform, as a full product module.** Its pipelines/environments/runs schemas, its console pages, and its worker jobs run as `app/products/deployment/` using the platform's queue, agent identities (L5) for runner credentials, metering (cost events with the `deployment` product tag), and observability. It does **not** need, and must not get, anything in the corporate plane or a private engine of its own.

**D5 — The consumer backend (when built) is the `chat` product module plus its own lightweight service if needed** — see `consumer/plan.md`. It shares the identity plane (ADR-001), calls the runtime plane like any customer program, and owns only conversation-UX data (sharing, preferences). It is product #3, not architecture #2.

**D6 — The corporate plane stays air-gapped from all of this.** neryva.com's backend never serves product traffic; its only bridge is federated identity (final_analysis 06 §8).

## Why this and not the alternatives

| Alternative | Rejected because |
|---|---|
| Two backends (consumer engine + console engine) | Duplicates identity/tenancy/guardrails/metering; cross-product invariants (one identity, one metering plane) become integration projects forever. No market leader does this. |
| Products as separate services from day one | Three deployables, three CI paths, distributed transactions — before product #2 even has users. The module boundary gives the same isolation at monolith cost. |
| Console as a separate frontend-only app talking to a generic admin API | Loses the product integration contract (summary providers, entitlement-aware nav) that makes "one console, N products" real; becomes a second website-demo problem. |

## Consequences

- One database, one audit chain, one governance stack — RLS and the evidence chain cover product data automatically.
- Console sees all products through one contract; adding Deployment changes zero console shell code (manifest-driven).
- Hot-path scale (runtime plane) can later get its own processes behind the same routes without touching products — a deployment concern, not an architecture change.
- The import-linter contracts from final_analysis 05 Phase 1 gain a second rule: `app/products/*` may import `app/{identity,gateway,guardrails,governance,metering,…}`; nothing may import `app/products/*` except route registration.
