# 00 — Architecture Overview: How Neryva Is Laid Out

**Date:** 2026-08-23
**Status:** The entry-point narrative. Ties together `05-organization-plan.md` (planes/repos), `06-identity-architecture.md` (identity, decisions D1–D8 + Δ1–Δ8), and `07-developer-console-benchmarks.md` (evidence). Read this first, then the others as needed.

---

## 1. One sentence

**Neryva is one agent platform with many front doors: consumers knock on product surfaces, customer organizations knock on the developer console, machines knock on the API — and every door leads through the same identity, gateway, guardrail, and metering plane.**

## 2. The four planes

```
CORPORATE PLANE — neryva.com
  neryva-website (marketing frontend)  +  neryva_backend (CMS: blog, careers,
  contact, newsletter, website accounts)
  Sells the company. Never serves product traffic. Federates ("Sign in with
  Neryva") to the platform identity plane; depends on nothing else.

┌─────────────────────────────────────────────────────────────────────┐
│ PLATFORM PLANE — the Neryva Agent Platform                          │
│ (today: neryva_studio/backend; its own repo/root on extraction)     │
│                                                                     │
│  IDENTITY            ORGANIZATION          RUNTIME                  │
│  Neryva Accounts     tenants (=orgs)       session engine, threads, │
│  first-party OIDC    └─ projects           memory, compaction,      │
│  provider (email     memberships           tools/MCP               │
│  code / password /   (owner/admin/                                 │
│  passkey / social)   billing/developer/    GOVERNANCE              │
│  API keys            reader), invites      policy engine, guardrail │
│  agent identities    entitlements          stack, PII redaction,    │
│  (L1–L5 layers)      (individual/team/     evidence, audit chain,   │
│                      enterprise)           RLS tenant isolation     │
│                                             METERING & OPS          │
│  Public OpenAI-compatible API               spend events, quotas,   │
│  + pinned contract + SDKs                   metrics, SLOs, evals    │
└──────┬────────────────┬────────────────┬────────────────────────────┘
       │                │                │
PRODUCT PLANE — every product is a thin vertical over the platform
  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐
  │ STUDIO (today) │  │ CUSTOMER APPS  │  │ FUTURE PRODUCTS        │
  │ dev console UX │  │ customers' own │  │ consumer chat, mobile, │
  │ + widget +     │  │ code calling   │  │ marketplace… each =    │
  │ product        │  │ the OpenAI-    │  │ 1 OAuth client + 1     │
  │ endpoints      │  │ compat API     │  │ entitlement + token    │
  └────────────────┘  └────────────────┘  │ exchange               │
                                          └────────────────────────┘
RESEARCH PLANE — PhaseForge, moe_route: feeds the platform, never deploys.
```

## 3. The five doors — who authenticates how

| # | Actor | Knocks on | Credential (token layer) | Can do |
|---|---|---|---|---|
| 1 | **End user** (consumer) | Product surfaces — the widget on a customer's site; a future consumer app | **L4 end-user session token** — anonymous, Fernet-encrypted, bound to tenant+surface+device, 12 h, row-revocable | Chat. Spend counts against the customer org's quota. Never sees the console |
| 2 | **Org human** (customer admin / developer / billing) | **Developer console** (Studio UI) | **L1 console session** — email one-time code (passwordless-first) or password/passkey via the first-party OP; short-lived JWT + rotating refresh; step-up MFA proof for privileged acts | Configure agents, policies, prompts, tools; create projects and keys; invite members; watch usage/evals/spend |
| 3 | **Customer's program** | OpenAI-compatible API, webhooks, admin API | **L2 API key** (`nrv_live_`, hashed, project-scopable) or **L3 service token** (client credentials / token exchange) at product scale | Whatever the key's role/scopes/quota allow |
| 4 | **Customer's agents/tools** | Tool & MCP surfaces | **L5 agent identity** — 15 min–1 h hashed tokens, KMS-ready, rotatable | Narrow machine permissions under the tenant |
| 5 | **Enterprise tenant's users** | Console via their own IdP | Inbound federation (SAML/OIDC) + SCIM provisioning/deprovisioning — enterprise tier only | Everything their org role allows; removed from IdP ⇒ removed from Neryva |

Plus two staff doors: **Neryva operators** use the same console login (L1) with platform roles (super_admin/tenant_admin/operator/auditor) + MFA; the **break-glass bootstrap key** covers IdP outages. And the **website door**: neryva.com visitors keep local accounts (newsletter) or link a Neryva Account.

## 4. Console ≠ product (the distinction that orders everything)

Two surfaces get confused constantly; the architecture separates them cleanly:

- **The developer console is the platform's control surface** — where *customer organizations* (and our operators) configure and observe. It is product-agnostic: it manages tenants, identity, projects, keys, policies, usage — the same furniture for every current and future product. Benchmarked against [platform.claude.com](https://platform.claude.com/login) and platform.openai.com (doc 07).
- **Products are what end users experience** — today the Studio widget (embeddable agent surfaces); tomorrow consumer apps, mobile, marketplace items. A product owns its UX and product-specific data; it borrows identity, gateway, guardrails, and metering from the platform and never reimplements them.

In repo terms (until extraction): the platform + console live in `neryva_studio/backend` + `frontend/`; the widget is product surface #1. After extraction: `platform/` and `products/studio/`.

## 5. Journey 1 — a consumer sends a chat message (the hot path)

```
widget (customer's site)
  → L4 token checked (decrypt → revocation row)
  → guardrail input pipeline (regex fastpath → classifier → … shadow layers)
  → policy evaluation (deny-by-default, tenant's published set)
  → session engine: thread append + context assembly (redacted-only, compaction)
  → LLM gateway: routing strategy → provider (fallbacks, cooldowns, caches, quota)
  → streamed back with rolling-window output moderation
  → guardrail evidence + audit event (hash chain)
  → spend event metered to (org → project → surface → end-user caps)
```

Every token of model traffic in Neryva — from any product, any surface — walks this same path. That is invariant #2 (one gateway/safety plane) made concrete.

## 6. Journey 2 — a company becomes a customer (the org lifecycle)

1. A developer signs up at the console: email one-time code → **Neryva Account** + a personal org (individual tier).
2. They upgrade to a team plan (entitlement) and **invite teammates** (`org_invites`, roles: owner / admin / billing / developer / reader — invites are the only way in).
3. They create **projects** ("staging", "europe", "support-bot") — each with project-scoped `nrv_live_` keys, its own spend limit, its own usage view.
4. They embed the widget (surface) → their end users arrive with L4 tokens, metered to the project.
5. At enterprise tier they attach their **own IdP** (SAML/OIDC) — their people sign in through Okta/Entra, SCIM provisions and deprovisions them, domain capture locks the org.
6. Their agents/tools get **L5 agent identities**; their servers use L2/L3.

At no point in this lifecycle does the identity plane change shape — only rows are added (accounts, memberships, invites, projects, keys, entitlements).

## 7. Journey 3 — a new product is added (the future-proofing proof)

When Neryva ships product #2 (say, a consumer chat app):

1. One `oauth_clients` row (its UI is an OIDC client of our OP).
2. One `product_entitlements` definition (its plans/limits).
3. Its backend holds a client credential and calls the platform via **token exchange** (acting for a user) — audit chain sees who *and* through which product.
4. Its usage events carry its product tag into the same metering plane.
5. Anonymous users use L4 tokens exactly like the widget does; registered ones hold Neryva Accounts.

No new identity system, no new gateway, no new policy engine, no schema surgery. The console manages it with the same furniture. **This is the whole point of the architecture.**

## 8. Where data lives

| Data | Home |
|---|---|
| Accounts, credentials, sessions, clients, invites, memberships, entitlements | Platform — identity schema |
| Tenants, projects, keys, policies, prompts, tool registry, model catalog | Platform |
| Threads/messages/evidence/audit (the runtime) | Platform |
| Spend/quota/usage | Platform |
| Product UX, product-specific state (e.g., a future app's sharing/social data) | The product's own store |
| Website content, newsletter, careers | Corporate (MongoDB — stays) |
| Never anywhere | A password in a product repo; an LLM call outside the gateway; production state in the research plane |

## 9. Build order (implementation roadmap, in sequence)

| Step | What | Doc |
|---|---|---|
| Done | Org docs, repo map, boundary decisions | 05 |
| Next | **Phase 1**: platform/product import boundary enforced in CI (no code moves) | 05 §8 |
| Then | **I-0/I-1**: identity module skeleton → first-party OP (email code login) → console login cutover; then Δ2 projects, Δ3 invites | 06 §12, 07 §5 |
| Then | **I-2**: website bridge ("Sign in with Neryva", linking) | 06 §8 |
| On trigger | **I-3**: token exchange + entitlements (product #2, or earlier); **Phase 3** extraction to org monorepo | 06, 05 |
| Enterprise demand | **I-4**: passkeys, inbound SAML/SCIM, custom roles | 06, 07 |

## 10. Document map

`00` this overview → `05` planes/repo strategy → `06` identity plan of record (D1–D8, Δ1–Δ8, schema, I-phases) → `07` console benchmarks (evidence + deltas). `01–04` remain the studio-health/optimization/feature program docs.
