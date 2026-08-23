# Frontend & Portal Plan v2 — One Web App, One Engine

**Status:** Plan of record (v2 per ADR-004 Amendment 1) · **Date:** 2026-08-23
**Decided by:** [ADR-004](decisions/ADR-004-frontend-portal-corporate.md) (+Amendment 1) · **Supersedes:** v1 of this file; the "one console SPA" clause of `console/overview.md`; the corporate-backend clauses of final_analysis 05/06.

## 1. The frontend end state (final)

| Kind | App | Location | Serves | Auth |
|---|---|---|---|---|
| **The web app** (only frontend) | neryva-website (evolved) | `corporate/neryva-website/` | Marketing (`/`) + platform console (`/platform/**`) + **product pages as route areas** (`/studio/**`, `/deployment/**`, …) | L1 (engine OP) |
| **Widget** | studio's embeddable surface | `products/agent-studio/widget/` | End users on customer sites | L4 |

That's all. No `console/` app (deprecated → ported → deleted), no per-product apps, no second website. One engine behind everything.

## 2. Route map (platform.openai.com vocabulary, one domain, one app)

```
neryva.com/                       marketing (existing pages — kept)
neryva.com/platform               console home: org header, project selector, PRODUCT CARDS
                                  (owned → live summary + "Open" → /studio, /deployment, …;
                                   not-owned → brief + trial CTA; states per console/access-model.md)
neryva.com/platform/organization/members · /invites
neryva.com/platform/projects
neryva.com/platform/api-keys
neryva.com/platform/usage          per org/project/product; the consolidated rollup view
neryva.com/platform/billing        per-product LEDGERS (separate by ADR-001 / partitioning §3)
neryva.com/platform/audit
neryva.com/platform/settings       org profile, SSO connection (enterprise), SCIM
neryva.com/studio/**               Agent Studio product pages (REAL pages — §3)
neryva.com/deployment/**           Deployment product pages (same pattern, when built)
```

## 3. Product pages: from static demos to real areas

The website already contains product-dedicated page trees (`src/pages/products/agent_studio/` — 25 pages, `deployment/` — 16) driven by static JSON packs. Plan per product area:

1. **Keep the routes and layouts** (the demo trees are the right skeleton: nav, shells, sections).
2. **Replace static packs with engine API calls** — every page re-wired to real endpoints (`/console/agent-studio/**` control-plane APIs), real data, real actions.
3. **Port missing working features from `console/`** — the deprecated studio frontend's feature modules (policies, traces, harness, evaluations, tenants, security, handoffs, workflows, usage, dashboard) are React components wired to the real API; they move into `/studio/**`. Ported modules keep their API layer; only shell/nav adapts.
4. Manifests declare `portal.base_path` (`/studio`, `/deployment`); portal cards and nav render from manifests + summary providers exactly per `console/product-integration.md` (deep links are in-app routes now — simpler than v1).
5. Entitlement-aware areas per `console/access-model.md` (read-only banners on past_due/suspended/expired; un-owned products show their demo-quality marketing area + trial CTA — the one place static content survives deliberately).

## 4. Session and navigation (simple now)

Single app ⇒ no cross-app SSO to engineer: one login via the engine OP, one session, one router. `/platform` and `/studio/**` share the header (org/project context), design tokens stay in-app. Step-up MFA (X-MFA-Proof) on privileged acts unchanged.

## 5. The corporate module (engine) — absorbing neryva_backend

Unchanged from v1: `engine/app/corporate/` (contact, newsletter, careers, blog admin, transactional email — Postgres, RLS-isolated Tier-2 module; public endpoints `/public/*`, staff content admin `/platform/content/**`). The email service also unblocks doc 06 Q1 (OTP emails).

## 6. What happens to each existing thing

| Thing | Disposition |
|---|---|
| **neryva-website** | Becomes the one web app: keep marketing; build `/platform` (real); convert product demo trees to real areas; drop `neryva_backend` API calls → engine `/public/*` + `/platform/*`; **remove its local auth pages** — login is the Neryva Account (ADR-004 D4). |
| **console/** (old studio frontend) | **Deprecated (ADR-004 Am.1).** Step 1: captured into git by reorganization-guide Stage 1 (it is currently UNVERSIONED — deleting before that is permanent loss). Step 2: feature modules ported into `/studio/**`. Step 3: deleted from the working tree after parity (§7). |
| **widget** | Unchanged (L4, embeddable). |
| **engine** | Gains `app/corporate/` + identity module (06 I-1) — everything else already serves these surfaces. |

## 7. console/ port-and-retire checklist (mirrors neryva_backend's)

1. Reorganization-guide Stage 1 captures `console/` into git (renames from `frontend/`). **Non-negotiable before anything else.**
2. Add `console/DEPRECATED.md` ("donor for /studio/**; delete after parity — ADR-004 Am.1").
3. Port in dependency order: API client/shared → dashboard/usage/evaluations → policies/security/harness/traces/tenants/handoffs/workflows → auth removal (OP login replaces it).
4. Parity gate: every `/studio/**` route covers its `console/` equivalent against the real engine API; ops walkthrough signs off.
5. `git rm -r console/` (history retains it); remove from workspace/build configs.

## 8. neryva_backend retirement — unchanged from v1

Corporate module live → website forms re-pointed → Mongo data migrated (newsletter/contact worth keeping) → two-week unused verification → archive folder, shut Vercel + Atlas, update REPO_MAP.

## 9. Build order

1. **Git/tree recovery + alignment** — `reorganization-guide.md` v4 (captures console/, widget, corporate, engine move — everything unversioned becomes versioned).
2. Engine **identity module** (06 I-1) — login for the whole web app depends on it.
3. Engine **corporate module** (§5) → website de-points from neryva_backend.
4. Web app **`/platform` area**: home + product cards (manifests/summaries), members/invites, projects, keys, usage, billing, audit, settings — real APIs.
5. **`/studio/**` becomes real**: port console/ feature modules into the demo skeleton (§3, §7).
6. Parity → **delete console/**; then the **Deployment product** (engine module + `/deployment/**` real area) as the pattern's second instance.
