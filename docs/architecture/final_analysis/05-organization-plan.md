# 05 — Company-Wide Organization Plan: Platform, Products, and the Website Backend

**Date:** 2026-08-23
**Status:** Proposed (company-scope). This document lives in the studio repo because that is where the analysis was done; Phase 0 promotes it to the org-level docs home.
**Audience:** Neryva engineering (current and future), leadership.
**Question answered:** *"We have `neryva_backend` (the dedicated backend) and `neryva_studio` (a product). Is making them standalone correct? How should we have organized and designed this, the way OpenAI / Anthropic / Google / DeepSeek / Z.ai do? Give the final plan."*

---

## 1. TL;DR verdict

1. **Standalone repos are the right call — but the boundary is drawn in the wrong place.** The problem is not "two repos." The problem is that the **agent platform lives inside a product repo** (`neryva_studio/backend` is ~90% platform, ~10% studio product), while `neryva_backend` — which everyone calls "the dedicated backend" — is actually the **neryva.com marketing-website backend** (blog, careers, contact, newsletter, website accounts). It contains zero agent, LLM, tenant, or platform code.
2. **Nothing needs a big-bang reorganization today.** The studio is contract-first, self-contained, and at its L1-pilot gate; the website backend is a legitimate standalone CMS. Both are compatible with the target below. The plan is phased and **trigger-based**: we pay for each reorganization only when a concrete need arrives (second product, external API consumers, team split).
3. **The one structural gap that will hurt at enterprise scale is identity.** There are two independent account systems (MongoDB website users vs. platform tenants/API keys with MFA) and no bridge. Every comparable company (OpenAI, Anthropic, Google, DeepSeek, Z.ai) has **one identity plane** across all surfaces. Fixing this — platform as the company IdP, website federating to it — is the single highest-leverage move in this plan (Phase 2).
4. **Target shape:** three planes + research — **Corporate** (neryva.com website + its backend), **Platform** (the Neryva Agent Platform extracted from studio, someday its own repo or the root of a monorepo), **Products** (Studio today; whatever comes next), and **Research** (PhaseForge, moe_route, product scratch — out of the production tree entirely).

---

## 2. Ground truth: what we actually have

Verified by direct inspection on 2026-08-23 (not from memory or naming):

| Path | What it really is | Stack | Deploys to | Identity |
|---|---|---|---|---|
| `neryva_backend` | **neryva.com website backend**: auth (JWT 15m + 7d refresh + OTP + bcrypt), blog CMS, career applications, contact form, newsletter, email (nodemailer), images (Cloudinary) | TypeScript / Express / MongoDB / Mongoose, Swagger, jest | Vercel (serverless entry `api/index.ts`) + PM2 option | Own users (`admin`/`editor`/`viewer` roles) in MongoDB |
| `neryva-website` | neryva.com marketing frontend | React / Vite / TanStack Router & Query | Static/Vercel | — (consumes website backend) |
| `neryva_studio` | **The agent platform product**: `backend/` (218-file FastAPI multi-tenant platform: tenancy, API keys + MFA/TOTP + OIDC module, session engine, LLM gateway, guardrails, policy engine, governance/RLS/audit, usage/spend, OpenAI-compat API — 103-path pinned contract), `frontend/` (admin console), `widget/`, `sdks/`, `contracts/`, `ops/`, `evals/` | Python / FastAPI / Postgres / Alembic + pnpm workspace frontends | docker-compose today, Helm chart staged | Own plane: tenants, API keys, principals, MFA |
| `website` | Stray directory containing only `docs/` — duplicate/leftover of `neryva-website` | — | — | — |
| `neryva_product_12` | Scratch/eval workspace (configs, data, outputs, error notes) | Python | none | — |
| `PhaseForge`, `moe_route` | Research projects (simulation/experiments; MoE routing) | Python | none | — |
| `Neryva/docs/` | Contains only `opencode.json` — no org-level architecture home | — | — | — |

**Cross-coupling audit:** zero. The only occurrence of "neryva.com" in the studio backend is a metric label. The two backends share no code, no auth, no database, no contracts. This is a **clean slate** — nothing has to be untangled, only organized.

---

## 3. The corrected mental model

The naming has been hiding the real architecture. Corrected:

```
NERYVA (company)
│
├── Corporate plane ............ neryva.com itself
│     neryva-website  (frontend)
│     neryva_backend  (website backend: CMS + website accounts)
│     — Sells the company. Never hosts product traffic.
│
├── Platform plane ............. "The Neryva Agent Platform"
│     Today: neryva_studio/backend/app  (misleadingly named "studio backend")
│     Owns: tenancy, API keys/MFA/OIDC, session engine, LLM gateway
│           (routing/fallback/quota/caches), guardrail stack, policy engine,
│           governance (RLS/evidence/audit), usage/spend/metering,
│           observability, the public OpenAI-compatible API + contracts + SDKs
│     — The thing every current and future product is built ON.
│
├── Product plane .............. Products built on the platform
│     Today: Neryva Agent Studio (admin console frontend, widget,
│             studio product endpoints, evals/ops tooling)
│     — Owns product UX and product-specific data/handlers.
│
└── Research plane ............. PhaseForge, moe_route, product scratch
      — Feeds the platform; never deployed from here.
```

So the answer to *"should `neryva_backend` have been designed differently?"* is: **no — it is correctly designed for what it is** (a small standalone CMS/auth backend for a marketing site; even OpenAI's marketing site is not coupled to their model platform). What was missing is not a redesign of it, but (a) **naming** — it should be called `website-backend`, because "neryva_backend" implies it is the company's backend of record, which is exactly the confusion that prompted this analysis; and (b) a **decision** that platform concerns (tenants, agents, LLM calls, guardrails) must never grow into it.

---

## 4. How the top companies organize — and the invariants they all share

Public-architecture view (what is observable from outside each company, not internal code claims):

| Company | Consumer product | Developer platform | Account plane | Pattern |
|---|---|---|---|---|
| OpenAI | ChatGPT (chat, projects, memory) | platform.openai.com + api.openai.com | One account (auth flow shared across chat + platform) | Product backend and API platform are separate services over a shared model-serving + safety + metering core |
| Anthropic | claude.ai | console.anthropic.com + API | Linked/one account across console and product | Same: product owns conversations; platform owns keys, usage, billing, safety |
| Google | Gemini app | AI Studio + Vertex AI / Gemini API | Google accounts | One identity, one model-serving/safety core, many vertical surfaces |
| DeepSeek | chat.deepseek.com | platform.deepseek.com (OpenAI-compatible API) | One account, two front doors | Famously small team: one inference platform, the chat app is a thin consumer surface |
| Z.ai (Zhipu) | chat.z.ai | api.z.ai / open.bigmodel.cn | One account plane | Same: consumer chat is a product on the GLM open platform |

The **invariants** shared by all five — these are the actual "state of the art," not monorepo-vs-polyrepo:

1. **One identity plane.** Every surface authenticates against a single account system. No product ships its own password store once a company account exists.
2. **One gateway/safety plane.** Model routing, rate limits, and guardrails are platform services consumed by all products. The consumer chat app does not run a second, divergent guardrail stack.
3. **One metering plane.** Usage events from every surface (consumer app, API, partner products) flow into a single metering/billing pipeline.
4. **Contract-first seams.** Platform↔product boundaries are versioned APIs with generated SDKs — not shared databases, not copied code.
5. **Products own product data.** The platform has no schema for "a ChatGPT project" or "a Studio session folder"; product-specific state lives with the product.
6. **The corporate website is a separate, boring system.** Blog/careers/newsletter backends are never coupled to the model platform.

Neryva today satisfies **#4** (studio is already contract-first with a pinned 103-path OpenAPI spec and SDKs), **#5**, and **#6**. It violates **#1** (two account systems, no bridge) and is structurally at risk on **#2/#3** (the gateway/safety/metering core exists exactly once — good — but it lives inside a product repo, so product #2 would have to fork or vendor it).

---

## 5. Assessment of our current approach

### What we did right (keep)
- **Standalone website backend.** Correct size, correct stack for the job, zero platform coupling. `neryva_backend` staying out of the agent business is a feature.
- **Studio as a self-contained product repo.** Contracts, SDKs, evals, ops, CI, docs, CHANGELOG — this is more discipline than most products ever get, and it is exactly what makes the later platform extraction cheap.
- **The platform exists exactly once.** There is no duplicated guardrail/policy/gateway code anywhere else. We are organizing one copy, not de-duplicating two.

### What must change (the honest list)
1. **The platform is trapped inside a product.** `neryva_studio/backend` is the company's platform in disguise. Until it is named and bounded as such, every future decision (who owns it, what may depend on it, when it gets its own release cycle) will be made wrong by default.
2. **Two identity systems, no bridge.** Website users (MongoDB, JWT+OTP) vs. platform principals (Postgres, API keys + MFA + OIDC module). Fine while the audiences are disjoint; fatal for the enterprise story ("sign in with Neryva" across console + products + website) and for SSO/SCIM in customer tenants.
3. **Portfolio sprawl at the parent directory.** `website/` (empty duplicate) next to `neryva-website/`, research mixed with production trees, scratch dirs (`neryva_product_12`) beside them, and no org-level README that says what lives where. An enterprise auditor's first impression is made in this directory listing.
4. **Names lie.** `neryva_backend` (sounds like the company backend; is the website backend), `neryva_studio/backend` (sounds like a product backend; is the platform). Renaming is cheap now and expensive later.

---

## 6. Target organization

### 6.1 Ownership model (planes, enforced)

| Plane | Owns | May depend on | Never |
|---|---|---|---|
| **Platform** (Neryva Agent Platform) | Tenancy, identity/keys/MFA/OIDC, session engine, LLM gateway, guardrails, policy engine, governance, metering/usage, observability, public API contracts + SDKs | Its own infra | Studio product UX, widget, marketing anything |
| **Product: Studio** | Admin console, widget, product endpoints/surfaces, product evals & ops tooling | Platform (via contracts/SDK) | Its own auth, its own guardrails, its own gateway |
| **Corporate: website + website backend** | Marketing site, blog, careers, contact, newsletter, website accounts | Platform identity (federated, Phase 2); nothing else | Agent/tenant/LLM code — ever |
| **Research** | Experiments, simulations, routing studies | Platform released packages only | Deployment configs, production data |

### 6.2 Repo strategy — the decision

For a small team with enterprise ambitions, the two viable shapes are:

**Option A — org monorepo `neryva/` (recommended when extraction triggers):**

```
neryva/
├── platform/            # moved from neryva_studio/backend  (the agent platform)
├── products/
│   └── studio/          # frontend/, widget/, product endpoints, evals, ops tooling
├── corporate/
│   ├── website/         # from neryva-website
│   └── website-backend/ # from neryva_backend (renamed)
├── contracts/           # platform OpenAPI specs (source of truth)
├── sdks/                # generated + published SDKs
├── ops/                 # shared infra: monitoring, DR, deploy
├── docs/                # org-level architecture (this doc's future home)
└── research/            # PhaseForge, moe_route (or keep separate repos)
```

Why A: one CI standard, atomic cross-plane changes, one version set, no internal-package registry to operate. DeepSeek runs a consumer product plus an OpenAI-compatible API with a famously small team on essentially this shape (one platform, thin product surfaces). Monorepos (Google, Meta) are how small-to-mid teams keep N planes coherent; multi-repo (OpenAI/Anthropic) works because those companies staff dedicated platform teams and run internal package registries — we should not imitate their repo count before we have their headcount.

**Option B — polyrepo + versioned platform package** (`neryva-platform` on a private index, products pin versions): choose this only if platform and product work is owned by genuinely independent teams. Costs: version-skew coordination, contract-drift risk across repos, two CI systems to keep at parity forever.

**Decision rule:** stay in the current two repos (with corrected boundaries and naming) until a Phase 3 trigger fires; then go **Option A**. Do not do B.

### 6.3 Naming corrections (do in Phase 0/1, they are nearly free)

- `neryva_backend` → `website-backend` (or `corporate/website-backend` in the monorepo). Its README's first line: "Backend for neryva.com — the corporate website. Not the agent platform."
- Inside the studio repo, stop calling `backend/` "the studio backend." It is the **Neryva Agent Platform (studio-hosted)** until extraction. Code docs, README, and the ledger should use that language.

---

## 7. The identity bridge (Phase 2 — the one true enterprise unlock)

> **Full design:** `06-identity-architecture.md` — verified inventory of both auth systems, the first-party OIDC provider decision, the five token layers, the website bridge mechanics, and the phased migration. This section is the summary; that document is the plan of record.

This is the piece worth doing **before** any repo moves, because it is customer-visible and compounds:

1. **Direction: the platform is the identity provider of record.** It already has MFA (TOTP), API-key principals, session machinery, and an OIDC module (`backend/app/modules/sso/oidc.py`). The website keeps local accounts for marketing-only interactions (newsletter, comments) and adds **"Sign in with Neryva"** (OIDC federation to the platform) for anything that should carry across surfaces — exactly the auth.openai.com pattern shared by ChatGPT and the developer platform.
2. **Rule going forward: no new surface ships its own password store.** Every new frontend (including future products) federates to the platform.
3. **Enterprise customer SSO stays a platform feature** (SAML/SCIM on tenant identity — already on the missing-features register). Company identity and tenant identity are different axes; both terminate at the platform, never at a product.
4. **Metering joins identity:** the moment a second surface exists, its usage events must flow into the platform's spend/usage plane (already built: spend events, chargeback, usage routes). One metering plane, per §4 invariant #3.

---

## 8. Phased migration plan

Each phase has a trigger, actions, and an exit criterion. **No phase starts before its trigger.** This is what "no sloppiness" actually requires — not moving everything now, but never being surprised by structure.

### Phase 0 — Freeze, name, and map (now · days · cost ≈ zero)
- **Trigger:** this document.
- Write the org-level `REPO_MAP.md` / `ARCHITECTURE.md` (parent `Neryva/docs/` — currently near-empty) declaring the four planes and each repo's plane, using §6.1's ownership table verbatim.
- Rename in documentation everywhere (per §6.3); rename GitHub repos when convenient (redirects make this safe).
- Delete `website/` (empty duplicate) after confirming nothing references it; move `neryva_product_12` under research/archive.
- **Exit:** an engineer landing in any repo can answer "what plane is this, what may it depend on" from the README alone.

### Phase 1 — Draw the platform boundary inside the studio repo (next few weeks · no code moves)
- **Trigger:** Phase 0 done. (Rides along with normal studio work; no dedicated migration.)
- Codify the platform/product module boundary in `neryva_studio/backend/app`: product modules may import platform modules; **never the reverse**. Enforce with an import-linter contract in CI (`contracts` section of the studio's pyproject) — a failing check, not a convention.
- Mark the seam in the OpenAPI contract: which of the 103 paths are platform (tenancy, keys, policies, usage, governance) vs. studio-product surfaces. The spec is already pinned and versioned — this is a labeling task, not a refactoring task.
- **Exit:** CI enforces the dependency direction; the contract labels the seam. The repo is now "a platform with a product inside it," honestly structured, at zero runtime risk.

### Phase 2 — Identity + metering bridge (before the second product · weeks)
- **Trigger:** any of: enterprise "single Neryva account" requirement, admin-console SSO rollout, second surface.
- Platform: harden the OIDC provider path (it exists as a module; make it the referenced IdP), publish its discovery document.
- Website backend: add "Sign in with Neryva" as an additional IdP alongside local accounts (federated identity, account-linking table). Do not migrate the Mongo user base — link, don't convert.
- Adopt the no-new-password-stores rule (§7.2) in the org docs.
- **Exit:** one login works across website + platform console; the rule is written down and enforced in review.

### Phase 3 — Extraction (only when a trigger fires · one focused week)
- **Triggers (any one):** (a) a second product consumes the platform; (b) external/partner API consumers need platform releases decoupled from studio releases; (c) platform and product ownership splits across people/teams.
- Execute Option A (§6.2): platform moves to the org monorepo root, studio becomes `products/studio/`, website pair joins as `corporate/`. Use git history-preserving moves (filter-repo/subtree), one plane per PR series, CI duplicated to the monorepo first and repos archived after.
- Re-point the SDKs and contract consumers (already contract-first, so this is re-homing, not re-design).
- **Exit:** platform releases on its own version line; studio pins a platform version per release.

### Phase 4 — Governance parity across everything (continuous)
- One CI standard: the studio's bar (tests, lint, type-check, contract pinning, coverage gates) becomes the template; `neryva_backend` gets the same shape (it already has jest/eslint/swagger — add CI, type-check gate, API-spec pinning, and a CHANGELOG; it already keeps secrets out of git, verified).
- Security baseline org-wide: secret scanning, dependency scanning, release process (semver + changelogs) — the studio already models this; copy it.
- Observability parity: website backend gets uptime checks + structured logs shipped somewhere (it has winston); the platform already has Prometheus/SLOs/alerts.

---

## 9. Direct answers to the questions asked

- **"Is our current approach of making them standalone correct?"** — Yes for the corporate website, forever. Yes for the studio *as a product*, at repo granularity. No as an end state for the *platform*, which is currently nameless and boundary-less inside a product repo. Fix the boundary (Phase 1) long before you consider moving any code (Phase 3, trigger-based).
- **"How should we have designed `neryva_backend`?"** — As exactly what it is: a small standalone website/CMS backend. The mistakes were the name ("neryva_backend" — indistinguishable from "the company backend of record") and the absence of an identity-federation plan, both fixed by Phases 0–2 without rewriting it.
- **"Should we organize like OpenAI / Anthropic / Google / DeepSeek / Z.ai?"** — Imitate their **invariants** (§4), not their repo counts: one identity plane, one gateway/safety plane, one metering plane, contract-first seams, products own product data, corporate site fully separate. Their multi-repo structure is a staffing artifact, not the virtue. At our scale, when extraction triggers, the DeepSeek-style shape — one platform, thin product surfaces — is the honest target.
- **"What is the final plan?"** — §8: name and map now, enforce the platform boundary in CI next, build the identity bridge before the second product, extract to the org monorepo only on trigger, and hold every repo to the studio's governance bar.

---

## 10. What this plan deliberately does NOT do

- **No big-bang reorganization.** The studio is at its L1-pilot gate with a large landed batch; re-homing code now would burn the pilot window for zero customer value.
- **No merging of the two backends.** They are different planes with different stacks, SLOs, and blast radii; coupling them would be the single worst move available.
- **No rewriting the website backend** to "align" with the platform stack. Polyglot planes are normal; what must align is governance (Phase 4), not language.
- **No premature platform extraction** "for cleanliness." Extraction happens on a trigger (§8 Phase 3), and the Phase 1 import boundary makes the eventual move mechanical instead of archaeological.
