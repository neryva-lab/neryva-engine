# ADR-004 — Frontend Topology (Portal + Product Apps) and Corporate Backend Absorption

**Status:** Accepted · **Date:** 2026-08-23 · **Amends:** [ADR-003](ADR-003-backend-topology.md) (corporate plane no longer has its own backend; console-shell clause superseded), final_analysis 05 §3/§6 (corporate plane), 06 §8 (website federation bridge). Where this ADR disagrees with earlier docs, **this ADR wins.**

## Context (owner's decision, 2026-08-23)

1. `neryva-website` becomes **the full web frontend implementation** — not only static marketing: it hosts the **platform console** ("the major pages"), modeled on platform.openai.com, with the same route vocabulary.
2. The former Agent Studio frontend (now at `console/`) is **the studio product's dedicated pages** — the pattern every product follows (studio, deployment, product-23…): dedicated, deep-linked pages.
3. **One engine serves everything. There is no separate corporate backend.** `neryva_backend` (the Express/MongoDB CMS) is absorbed into the engine and retired.

## Decisions

**D1 — The portal app (`corporate/neryva-website`).** One web app owns `neryva.com`: marketing pages (as today) **plus** the authenticated platform console at `/platform/**` — org home with product cards, members/invites, projects, API keys, usage, billing, audit, settings. Route vocabulary mirrors platform.openai.com (see `frontend-and-portal-plan.md` §3). It is an OIDC client of the engine's identity provider (L1 sessions).

**D2 — Product console apps.** Each product ships its dedicated pages as its own frontend app, deep-linked from the portal's product cards (manifest-declared URL). `console/` **is the Agent Studio product app** (its current pages are studio-specific; later products copy the pattern, not the code). This supersedes the "one console SPA with lazy product chunks" clause in `console/overview.md` — the invariants that survive: one portal, one identity, manifest-driven links, entitlement-state-aware cards.

**D3 — The engine is the only backend.** A `corporate` module inside the engine (`engine/app/corporate/`) absorbs neryva_backend's duties: contact submissions, newsletter, careers, blog admin, transactional email — Postgres tables, RLS-isolated, Tier-2-style module per [partitioning.md](../partitioning.md). Marketing pages stay static/pre-rendered from content JSON; only form/API traffic hits the engine. **neryva_backend is retired** after parity (checklist in the plan §7): its folder is archived, its MongoDB data migrated or dropped, its Vercel deployment shut down.

**D4 — Identity unchanged but simpler than designed.** Website accounts are Neryva Accounts issued by the engine's OP — no separate Mongo user store, no linking bridge (06 §8 is superseded: the bridge existed to keep two backends; there is now one). Newsletter-only subscribers become plain email rows in the corporate module (no accounts).

**D5 — Widget unchanged** (studio product's end-user surface, L4 tokens).

## Amendment 1 (2026-08-23, same day — owner's consolidation: ONE web frontend)

**D2 is replaced.** There are **no separate product apps.** `corporate/neryva-website` is the **only web frontend**:

- `/` marketing (as today);
- `/platform/**` the platform console (D1 unchanged);
- `/studio/**`, `/deployment/**`, … **product pages as route areas inside the one app** — the product-dedicated pages the website already contains (today: static content-pack demos) are rebuilt as real, engine-wired pages.

`console/` (the former studio frontend) is **deprecated, not a product app**: it is committed to git, its working feature modules (policies, traces, harness, evaluations, tenants, usage, workflows…) are ported into the web app's product areas, and it is deleted from the working tree **only after parity** (same retirement pattern as neryva_backend; checklist in the plan §7). Until Stage 1 of the reorganization guide captures it into git, it is unversioned — **deleting it before then is permanent loss** of the only functional admin UI. Everything else in this ADR stands.

## Consequences

- Portfolio end state: **one engine, one portal app, N product apps, one widget, zero side backends.**
- The portal and product apps must share: the OIDC session (single sign-on across apps), design tokens, and the deep-link manifest — specified in the plan.
- Marketing availability is decoupled from the engine (static pages); only portal/forms depend on it.
- Cost accepted: neryva_backend's Express/Mongo code is thrown away (its duties are ~5 endpoints); benefit: one backend, one database, one audit chain, one deploy pipeline.
- ADR-003's topology diagram gains the corporate module; its "corporate plane stays air-gapped" clause narrows to: *the marketing frontend stays separate; corporate duties run as an isolated engine module that never touches product data* (partition Tier 2).
