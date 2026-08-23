# The Developer Console — Architecture Overview

**Status:** Plan of record · **Date:** 2026-08-23 · **Bound by:** [ADR-002](../decisions/ADR-002-product-taxonomy.md) (three products), [ADR-003](../decisions/ADR-003-backend-topology.md) (one engine, control plane), final_analysis 06/07 (identity, benchmarks)

## What the console is

The console is the **single shared control surface** over the platform engine — Neryva's equivalent of platform.claude.com / platform.openai.com. One console manages **every** product through the same furniture: account/org header, product cards, entitlements, members, projects, keys, billing, usage. It is *not* a product itself and *not* per-product — products plug into it ([product-integration.md](product-integration.md)).

Explicit disambiguation (agreed 2026-08-23): **product marketing pages** (on neryva.com — single-page adverts) and **product console pages** (inside the console — the working management UI) are different artifacts on different planes. The website clones nothing; the console is the only real management UI.

## Sign-in and landing

1. **Sign in** — email one-time code (primary), password, passkey, or federated social (per final_analysis 06 Δ1); enterprise orgs arrive via their own IdP (SAML/OIDC, SCIM-provisioned).
2. **Context resolution** (ADR-001): the account's memberships load. Multiple orgs → **org picker** (OpenAI/Google-style). No org → org creation or invitation acceptance.
3. **Console home** (the "console detail page") — the product workbench.

## Console home layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ Neryva Console   [org: Acme ▾] [project: main ▾]      Usage  Billing  │
│                       Account ▾ (MFA, sessions, sign-out)             │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  YOUR PRODUCTS                                                        │
│  ┌─────────────────────┐  ┌─────────────────────┐                     │
│  │ Agent Studio        │  │ Deployment          │                     │
│  │ ● summary KPIs…     │  │ ● summary KPIs…     │   ← live summaries  │
│  │ [ Manage → ]        │  │ [ Manage → ]        │     per manifest    │
│  └─────────────────────┘  └─────────────────────┘                     │
│                                                                       │
│  AVAILABLE PRODUCTS                                                   │
│  ┌─────────────────────┐                                              │
│  │ Neryva Chat         │  ← not subscribed: brief + [Start trial]     │
│  └─────────────────────┘     (owner/billing only; others see "ask     │
│                              admin" — see access-model.md)            │
│                                                                       │
│  ORG: Members · Invites · Projects · API keys · Audit · Settings      │
└───────────────────────────────────────────────────────────────────────┘
```

- **Product cards** are rendered by the console shell from each product's **manifest + summary provider** — the shell contains zero product-specific code.
- **Every registered product always appears** (owned or not): owned → live summary + Manage; not owned → one-paragraph brief + trial/purchase CTA (entitlement-state driven; [access-model.md](access-model.md)). This is the discoverability loop OpenAI/Anthropic get from a single platform surface.
- **Manage →** deep-links into the product's console pages: `console.neryva.com/{product}/…` — route modules owned by each product, lazy-loaded into the console shell.

## Shell and navigation model

- **One SPA** (the existing studio admin console frontend, evolved). Product route modules register via manifest: nav sections, base route, icon. Lazy-loaded route chunks per product — adding a product adds a chunk, never a fork.
- **Two-level nav**: shell level (org-wide: members, projects, keys, billing, audit) and product level (the product's own nav inside its pages, from its manifest). The shell never hardcodes product nav.
- **Project selector** (global): scopes keys, limits, and usage views to the selected project (final_analysis 07 Δ2).
- **Entitlement-aware UI**: suspended/expired states render read-only banners with billing CTAs — never dead links.

## Console API surface (control plane, per ADR-003)

- `GET /console/home` — org header + resolved cards (manifest + entitlement state + summaries, gathered server-side).
- `/{product}/**` — product console routes (owned by product modules).
- `/console/org/{members,invites,projects,keys,billing,audit}` — org furniture.
- All console APIs authenticate with L1 sessions; privileged acts require step-up MFA (Δ5).

## Non-goals

- No per-product console apps, no micro-frontend infrastructure, no second shell. One shell, one contract.
- No consumer features in the console (chat lives in the consumer product; ADR-001 keeps identity shared, contexts separate).
- No marketing content in the console beyond product card briefs.
