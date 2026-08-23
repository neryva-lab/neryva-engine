# Neryva — End-to-End Architecture Explained

**Date:** 2026-08-23 · **Purpose:** the single, self-contained explanation of the target architecture — for understanding, review, and external consultation. Sources are the binding ADRs (ADR-001 through ADR-006) and plans in this directory plus `docs/final_analysis/05–07`.

---

## 1. The one-paragraph version

Neryva is **one AI platform engine** (TypeScript/NestJS core) with **two API faces** (a control plane for the developer console and a runtime plane for products and APIs), carrying **a small register of products** (Agent Studio today, Deployment next, consumer Chat later) that plug into the engine through a fixed registration contract. Heavy runtime workloads run as **Capability Deployments (Satellites)** that connect to the engine via a standard 4-part connection contract (the existing studio runtime is the first satellite: `agent-runtime`). **One identity plane** (a single Neryva Account that works everywhere, with organization contexts and enterprise SSO as separate axes) provides unified authentication across all surfaces. **One metering/governance plane** ensures every model call passes the same gateway, guardrails, policies, and audit chain, billed independently per product. A single unified web application (`corporate/neryva-website`) hosts marketing, the `/platform` console, and deep-linked product areas (`/studio/**`, `/deployment/**`), with corporate forms and email handled directly by the engine's `corporate` module.

## 2. The map

   CONSUMERS                     COMPANIES (developers/admins/billing)        NERYVA STAFF
      │                                │                                        │
      ▼                                ▼                                        ▼
┌──────────────┐            ┌─────────────────────────────────────────────────────────┐
│ Chat product │            │ UNIFIED WEB APP (neryva-website)                         │
│ (future) /   │            │ / (marketing) · /platform (console) · /studio · /deploy │
│ widget on    │            └──────────────────────────┬──────────────────────────────┘
│ customer site│                                       │ L1 console sessions
└──────┬───────┘                                       ▼
       │ L4 anonymous tokens               ┌──────────────────────────────────────────────────┐
       │                                   │          CONTROL PLANE  (console APIs)           │
       │                                   │  orgs · members · invites · projects ·           │
       │                                   │  entitlements · manifests · summaries · billing  │
       │                                   ├──────────────────────────────────────────────────┤
       │  L2 API keys ────────────────────▶│          RUNTIME PLANE  (public APIs)            │
       │  L5 agent idents ────────────────▶│  OpenAI-compatible API · surfaces/widget ·       │
       │                                   │  product runtime routes (deployment API)         │
       │                                   ├──────────────────────────────────────────────────┤
       └──────────────────────────────────▶│  ENGINE CORE (TypeScript / NestJS — Brain/Money) │
                                           │  identity (accounts, OIDC provider, L1–L5 tokens)│
                                           │  tenancy + RLS · governance & policy decision   │
                                           │  metering ledgers & quotas · corporate module    │
                                           │  audit chain · product manifests & console home  │
                                           └──────────────────┬───────────────────────────────┘
                                                              │ 4-part connection contract (L3)
                                           ┌──────────────────┴───────────────────────────────┐
                                           │ CAPABILITY DEPLOYMENTS (Satellites)              │
                                           │ ├── agent-runtime (Python - session/gateway/RAG) │
                                           │ └── (future) inference (GPU model serving)       │
                                           └──────────────────────────────────────────────────┘

## 3. Layer 1 — Identity: one account, many contexts

**Decision (ADR-001):** one Neryva Account everywhere — the Google/OpenAI identity model, not Anthropic's two separate account systems (verified: Anthropic's claude.ai and Console share nothing but a possible email match; OpenAI has one account with independent billing; Google has one account everywhere).

- **Login spectrum:** email one-time code (primary, passwordless — Anthropic's Console proves this at scale), password, passkey, federated social (later). One-way binding: a federated account never grows a password.
- **Contexts, not duplicate accounts:** the same human has a *personal workspace* (consumer side) and/or *organization memberships* (console side). Chat never sees org data; the console never shows chat content. Sign out everywhere works because sessions live in one registry.
- **Organizations:** the existing tenant table. Members hold converged roles — **owner / admin / billing / developer / reader** — billing deliberately separate from admin (the pattern at every benchmarked platform). Invites are the only way in. **Projects** (sub-org containers) scope keys, limits, and usage — OpenAI-projects/Anthropic-workspaces pattern.
- **Five token layers** (the firewalls between worlds):
  - **L1 console sessions** — humans in the console: short-lived JWTs + rotating refresh, revocable per device, step-up MFA for privileged acts.
  - **L2 API keys** — customer programs (`nrv_live_…`, hashed, project-scopable).
  - **L3 service tokens** — products and integrations acting via client-credentials/token-exchange; the audit chain records *who* acted *through which product*.
  - **L4 end-user session tokens** — anonymous widget/chat visitors, bound to tenant+surface+device, instantly revocable.
  - **L5 agent identities** — non-human principals (tools, agents, deployment runners), 15-min–1-h rotating tokens, KMS-held secrets.
  A token from one layer is never accepted on another layer's endpoints.
- **Enterprise SSO is a separate axis:** customer organizations can attach *their own* IdP (SAML/OIDC) with SCIM auto-provisioning/deprovisioning — enterprise-tier entitlement, exactly as OpenAI/Anthropic/Mistral gate it. Company identity and customer-tenant identity are different things that both terminate at the platform.

## 4. Layer 2 — The engine: one platform, two API faces

**Decision (ADR-003):** there are not "two backends" (a consumer one and a console one). There is **one engine** — today the studio backend — exposing:

- a **control plane** (`/console/**`): everything the console and customer IT touch — orgs, members, entitlements, product manifests and summaries, billing views;
- a **runtime plane** (`/v1/**`, `/surfaces/**`, webhooks, product runtime routes): everything products, programs, agents, and end users touch.

Both faces share one database, one tenant-isolation layer (RLS), one audit chain. Products are **bounded-context modules** inside the engine (`app/products/*`) that may import platform services and are imported by nobody. Cross-product needs go through the public contract with L3 tokens — products never read each other's tables.

What every product **inherits** from the engine (this list is why products stay thin): identity and all five token layers, tenancy/RLS, the LLM gateway (routing, fallbacks, quotas, caches — no product ever holds a provider key), the guardrail stack and PII redaction, the deny-by-default policy engine, the hash-chained evidence/audit trail, metering and quotas, the worker/queue, and full observability.

## 5. Layer 3 — Products: vehicles on the engine

**Decision (ADR-002):** a deliberately small register — adding a product requires amending an ADR, because the register *is* product strategy.

| Product | What it is | Faces | Surfaces |
|---|---|---|---|
| **Agent Studio** (exists) | build, govern, run agents | control + runtime | console pages; embeddable widget (L4); OpenAI-compatible API (L2); webhooks |
| **Deployment** (next) | pipelines, environments, gated rollouts for agents | control + runtime, **no consumer face** | console pages; deployment API + worker jobs with L5 runner identities; policy-gated promotions |
| **Chat** (future, trigger-gated) | the consumer product | **consumer** (first-party end-user app) + thin **control** (org seats/billing card); no runtime face initially | consumer web/app in the *personal context*; anonymous L4 → registered account upgrade |

**The registration contract (the scalability mechanism):** a product integrates by shipping exactly four artifacts — (1) a **versioned manifest** (key, nav, routes, scopes, entitlement codes, which faces it uses), (2) a **summary provider** (the KPI card the console home renders), (3) an **entitlement definition** (plans/limits on the quota engine; the state machine `none→trial→active→past_due→suspended→expired` is platform-owned), and (4) a **metering tag** on every spend event. The console shell contains **zero product-specific code**; adding product #20 adds a manifest and a lazy route chunk — no shell changes, no identity changes, no new permission systems. That is the structural answer to "the engine drives all products."

## 6. Layer 4 — The console: one dashboard over everything

One web application (evolved from the existing studio admin console):

- **Sign-in → context resolution → console home.** Multiple orgs → org picker. No org → create/accept invite.
- **Console home** = product cards for **every registered product**, always: owned products show live summaries with *Manage* deep-links into the product's pages; un-owned products show a brief with trial/purchase CTAs (only owner/billing see purchase buttons — others see "ask your admin"). Discovery is built into the dashboard, platform.claude.com-style.
- **Org furniture:** members, invites, projects, API keys, billing, audit.
- **Authorization composes three axes:** membership role × entitlement state × product scopes. Privileged acts (role assignment, ownership transfer, purchases, publishing policies) require **step-up MFA** — our equivalent of Anthropic's "owner/admin roles cannot be assigned via API" rule. Neryva staff roles (super_admin/operator/auditor) are a separate overlay in the same shell, never customer roles.
- The console is product-agnostic and identity-plane-safe: it is an **L1-only surface**; widget visitors and API programs never touch it.

## 7. Layer 5 — The corporate plane, absorbed and unified (ADR-004)

`neryva-website` is the **single frontend web application** across the company: marketing (`/`), the developer console (`/platform/**`), and deep-linked product pages (`/studio/**`, `/deployment/**`). There is **no separate corporate backend** — `neryva_backend` (Express/MongoDB) is absorbed into the engine's `corporate` module (`engine/src/modules/corporate`) and retired. Form submissions (`/public/{contact,newsletter,careers}`), transactional email, and blog content admin run directly on the engine core in PostgreSQL.

## 8. Three end-to-end journeys

**Journey A — a consumer sends a message.** Widget on a customer's site → anonymous L4 token minted → guardrail input pipeline → policy evaluation (deny-by-default; the customer org's published policy set) → session engine appends to the thread and assembles context (PII-redacted only, compacted) → LLM gateway routes to the best provider (fallbacks, cooldowns, per-project quota) → the answer streams back through rolling-window output moderation → evidence packet + audit event written (hash-chained) → spend event metered to org→project→surface→end-user caps. *Every product's model traffic walks this same path — that is the one-gateway/safety-plane invariant.*

**Journey B — a company becomes a customer.** Developer signs up (email code) → personal org → upgrades to team → invites teammates with roles → creates projects with project-scoped keys → embeds the widget / calls the OpenAI-compatible API → watches usage per project → at enterprise tier, attaches their IdP: their people sign in through Okta/Entra, SCIM provisions and deprovisions them automatically. At no point does the identity plane change shape — only rows are added.

**Journey C — an agent goes to production (two products cooperating).** A developer finishes an agent in Agent Studio's console pages → in the Deployment product, a pipeline promotes it dev→staging→prod, gated by policy checks (e.g., evaluation scores) → the deployment worker runs with L5 runner credentials → rollout strategy canary-watches guardrail/latency metrics from the observability plane → Studio's page shows "live in prod via pipeline X" by reading Deployment through the public contract. Two products, zero coupling, one audit trail.

## 9. Where data lives

| Data | Home |
|---|---|
| Accounts, sessions, clients, invites, memberships, entitlements | Platform identity schema (`identity.*` / `public`) |
| Tenants, projects, keys, policies, tool registry, model catalog | Platform core schema |
| Threads/messages, evidence, audit, spend/quota | Platform / `agent-runtime` satellite |
| Product-owned data (knowledge corpora, prompt suites · pipelines/environments/deployments/secrets · chat sharing/preferences) | The product module's own schemas (same PostgreSQL DB, RLS-isolated; extractable) |
| Website content, newsletter, careers, contact | Corporate module schema in PostgreSQL (absorbed per ADR-004; MongoDB retired) |
| Never, anywhere | A password outside the identity schema; a provider key outside the gateway; an unaudited privileged action; production state in the research plane |

## 10. The invariants (the elevator defense for any consultant)

1. **One identity plane** — every surface federates to it; no product stores credentials. *(Benchmark: Google/OpenAI account unification; the industry's converged console patterns.)*
2. **One gateway/safety/metering plane** — all model traffic, all products, same guardrails and billing events.
3. **Contract-first seams** — products and capability satellites integrate via manifest + public contract + token exchange (L3), never shared tables.
4. **Products own product data; the platform owns identity, tenancy, policy, metering.**
5. **One engine core, one web frontend, zero duplicate backends.**
6. **A new product is configuration + one module** — never an identity change, never a console fork.

**Deliberately rejected:** two parallel engines (duplicates the hard 80% forever); per-product consoles (marketing becomes the most expensive place to ship a product — we lived a mild version of this already); Anthropic-style split consumer/developer accounts (double identity infrastructure, destroyed conversion path); products as separate services from day one (distributed cost before users); the website as IdP or product host (wrong plane).

## 11. Honest state: what exists, what's next (consultation-ready)

**Exists today (verified in code):** the engine's runtime plane (session/threads, gateway, guardrails, policies, governance/RLS/audit, metering) with a 103-path pinned OpenAI contract; L2 keys, L4 end-user tokens, L5 agent identities, operator sessions, OIDC relying-party login, TOTP step-up; a working console frontend; the widget.

**Designed, not yet built (in order):** 
1. Git recovery & baseline (E0)
2. NestJS engine core with shared kernel & corporate email (E1)
3. Identity module with first-party OIDC provider and email-code login (E2)
4. Organizations, memberships, invites, projects, and entitlement state machine (E3)
5. Partitioning linters & namespacing (E4)
6. Control plane manifests, console home, and billing/metering engine (E5)
7. `agent-runtime` satellite connection handover (E6 / ADR-006)
8. Corporate completion, web frontend unification, and `neryva_backend` retirement (E7 / ADR-004)
9. Deployment product module & worker workflows (E8)
10. Hardening, benchmarking & final completeness audit (E9)
