# Engine Execution Plan — Corrected & Engine-Scoped

**Date:** 2026-08-23 · **Status:** proposed correction of the execution order in [`END-TO-END.md`](END-TO-END.md) §3
**Scope:** the **engine** (TypeScript/NestJS core, ADR-005/006) and the engine-side surfaces its satellites depend on. The Agent Studio backend rebuild ([ADR-007](../architecture/decisions/ADR-007-legacy-backends-references.md) / ledger A-6), the Python runtime's own product work, and the web-app frontend build are **other tracks** (§5) — tracked only where the engine blocks or unblocks them.
**Method:** every "current state" claim below was verified against the disk on 2026-08-23; every technology claim was checked against current documentation (sources in §2). Where this file disagrees with `END-TO-END.md` §3, the `reorganization-guide.md` move list, or the Python-terms steps inside `dev/*/plan.md`, **this file wins** — those files remain the behavioral specifications (schemas, state machines, flows, gates); this file fixes the *execution order, repository mechanics, and technology decisions*.
**Binding order:** ADR-001…007 → system plans (`architecture/`) → this file → workstream plans/ledgers.

---

## 0. Verified ground truth (what this plan is built on)

| Fact | Verified state (2026-08-23) |
|---|---|
| Studio repo | `products/neryva_agent_studio` — `.git` intact at `c1d24b3`, remote `Luke23-45/neryva-agent-studio`. **105 uncommitted changes** (39 untracked + 57 modified + 9 deleted: 8 SQLite test DBs `git rm`'d, `requirements.txt` deleted). `backend/`, `frontend/`, `widget/`, `contracts/`, `ops/`, `sdks/`, `evals/`, `data/`, `docs/` all still **inside** the repo and tracked |
| Engine repo | `engine/` — **its own separate `.git`** (2 commits, docs only), **no remote**, 1 modified + 2 untracked files |
| Website | `console/neryva-website` — clean, remote `Luke23-45/neryva-wesbite` (typo'd repo name) |
| Website backend | `corporate/neryva_backend` — remote OK, **2 uncommitted files** (`envConfig.ts`, `authController.ts`) |
| Root `neryva_studio/` | `architecture/` = **stale** copy (pre-ADR-005/006); `engine/docs/architecture/` = current copy; `contracts/`, `ops/`, `sdks/` = **empty** placeholder dirs |
| Contract | `contracts/openapi/openapi.v1.json` — **103 paths** (verified by load) |
| Runtime quota engine | `backend/app/gateway/quota.py` `_LEVELS = ("platform","tenant","surface","end_user")` — no product/project levels (senior-review F4 confirmed) |
| CI | `.github/workflows/{ci,docs,dr-drill,evals,loadtest}.yml`; `ops/docker/{backend,frontend,worker,widget}.Dockerfile`; `pnpm-workspace.yaml` = `frontend`, `widget` |

Two consequences drive most of §1: the reorganization guide's "⚠️ current state" description **no longer matches the tree**, and its Stage 2–3 (`git mv backend → engine`, `backend.app → engine.app` rewrite) **contradicts ADR-005 D4 / ADR-006 D3 / ADR-007** (the Python backend stays at `products/neryva_agent_studio/backend` as reference + production; `engine/` is the TS core).

---

## 1. Corrections register (contradiction → correction)

| # | Finding | Correction |
|---|---|---|
| **C1** | Reorg-guide Stage 2–3 moves the Python backend into `engine/` and rewrites `backend.app→engine.app` — contradicts ADR-005 D4, ADR-006 D3, ADR-007 | **Cancelled.** Python backend stays at `products/neryva_agent_studio/backend` (path and imports unchanged). `engine/` = TS core only. E0's "engine/ move + import rewrite" is deleted |
| **C2** | Reorg-guide "current state" (119 deletions, unversioned moved folders) is stale vs disk | Rewritten move list in **P0** below, matched to the verified tree |
| **C3** | The website sits at `console/neryva-website`, but ADR-004 Am.1 needs `console/` = deprecated studio frontend and the website at `corporate/neryva-website` | P0 moves: `console/neryva-website → corporate/neryva-website`, then `frontend/ → console/` (the donor) |
| **C4** | Two drifting copies of the architecture docs (root stale, engine current) | **Single source of truth: `engine/docs/`.** Root `architecture/` and the duplicated `final_analysis`/`dev` copies under the studio repo's `docs/` are deleted at P0; runtime-specific docs (`implementation/`, `notes/`, `ops/`, `portal/`) stay at root `docs/` |
| **C5** | Engine repo has **no remote**; studio repo has 105 uncommitted changes; `neryva_backend` has 2 | P0 step 0: commit + push **everything** before any move. Create the engine repo's GitHub remote (its docs are the plan of record) |
| **C6** | Dev plans allocate **Alembic** migrations 0017–0022 for identity/orgs/corporate/metering/deployment — but those modules are net-new TS (ADR-005 D2) and their tables are TS-owned from creation (ADR-005 D3) | Migration rule fixed: **engine-owned tables → TS migrations only** (numbered within the engine, e.g. `eng-0001…`); **the engine never alters Python-owned tables.** The only Python-repo migration this plan needs is one **additive** Alembic 0017 (`api_keys + project_id/owner_account_id/org_id NULL`) — see P3. `end_users` alteration stays deferred to the satellite track (A-2), per the O-1 ledger note |
| **C7** | Control-plane C-2 extends the **Python** `export_openapi.py` — but that script exports the Python app and can never see engine routes | **Contract composition v2** (P4): a composition script (engine-owned, in `contracts/`) merges the pinned runtime spec + the engine's `@nestjs/swagger` export into `contracts/openapi.composed.v1.json`; `x-neryva-owner` everywhere; CI bijection + collision check across both |
| **C8** | The reverse proxy appears at M5, but corporate email (E1) and identity (E2) need the engine publicly reachable long before | **Deploy lane moves to P1**: proxy (ops/) with route table `/v1`, `/surfaces`, `/internal` → runtime; everything else → engine as modules ship. M5 keeps only the shadow/parity harness |
| **C9** | Partitioning P-2/P-3/P-4 modify the **Python** quota engine, QueueManager, and cache manager — dead work once quota/queue authority moves to the engine (A-3), and the runtime is a reference now (ADR-007) | **Cancelled.** Product/project quota levels, queue namespaces (BullMQ), cache/metric namespacing are **engine-side** builds (B-1, D-4). The Python runtime gets no partitioning work beyond the A-phase handovers |
| **C10** | Agent-studio plan S-2 does `git mv` of Python route modules into a Python product package — contradicts the agent-studio ledger S-1 ("runtime external") and ADR-006/007 | **Cancelled.** Studio route ownership is **declared in the engine manifest** (external base URLs); no Python route moves. E6 = engine-side registration + handover surfaces |
| **C11** | Identity/access plans lean on `require_mfa_proof` "already exists" — that is the **Python** dependency | The **step-up MFA guard is net-new TS** in the kernel (same HMAC proof semantics: bind account/key-id to expiry, TTL-capped). Sized in K-3 |
| **C12** | Kernel K-3 includes an `L4EndUserTokenGuard` — but no engine route namespace is L4 (`/surfaces/**` is satellite-side, permanently under ADR-006/007) | **Deferred** (YAGNI). If ever needed: Fernet verify in-house via `node:crypto` (AES-128-CBC + HMAC-SHA256, constant-time compare) with fixture tests generated from the Python runtime — no maintained JS Fernet library exists (§2 F) |
| **C13** | "E7 parallel from E1" hides dependencies: website re-point needs OP login (I-1d) **and** content admin (E-3c) | Corrected ordering in P6: only the email service (P1) and forms/table build (P6a) are early; re-point + retirement are late |
| **C14** | I-1d assumes "the console client (the web app)" — but the web app's `/platform` area doesn't exist yet (frontend plan build order) | I-1d cuts over with a **minimal login page** in the web app (email code → PKCE → session). The old console frontend keeps working via runtime operator auth until the satellite's A-2 |
| **C15** | Doc-06 Q1 (email delivery) left open; identity I-1a is dead code without it | **Decided at P1:** a transactional email provider API (Resend / Postmark / SES — pick one, config-only) behind a transport port; dev transport = file/log. No self-run SMTP, ever |
| **C16** | ADR-005 lists "Prisma (or Drizzle)" as an unresolved either/or; RLS is Tier-0 for the engine | **Decision spike in P1 with a failing-test gate** (§2 A). Default recommendation: **Drizzle** (or Kysely). Prisma's RLS story is extension-based, officially "example-only," with a known interactive-transaction bug — evidence in §2 |
| **C17** | Billing B-1 requires the metering ingest to authenticate satellites with **L3** — but identity defers L3 to I-3 ("product #2 trigger") | **L3-lite ships in P4** (client-credentials grant on the OP for `kind=service` clients + audience validation) — the satellites' connection contract needs it. Full RFC 8693 token exchange (acting-for-user) stays deferred |
| **C18** | Deployment D-4 mints L5 runner identities — the L5 tables/authority are runtime-owned until handover | **P7 requires A-1 complete** (key/token authority engine-side) so the engine mints L5 into engine-owned authority. Dependency made explicit |
| **C19** | The A-1…A-4 handovers read like runtime work; each has an **engine-side build** the engine track owns | P5 = the engine side of every handover: key issuance/validation API, JWKS for satellites, metering ingest, policy/config publishing (store + versioned pull + push notify) |
| **C20** | Hygiene: typo'd remote `neryva-wesbite`; `Neryva/website/` stray; `neryva_product_12/` scratch | P0 step 7: rename GitHub repo (redirects are safe), archive `website/`, move scratch under research — per REPO_MAP standing rules |

---

## 2. Technology decisions (research-verified 2026-08-23)

**A — ORM for the engine (decide in P1, gate: RLS failing-then-passing test).**
Prisma has **no native RLS**; the official pattern is a Client Extension setting `SET LOCAL app.current_tenant` inside interactive transactions and is explicitly *"an example only, not intended for production"*; there is a known bug class with extended clients in interactive transactions (prisma#23583), connection-pool context-leak footguns (`SET` vs `SET LOCAL`), and Prisma Migrate does not manage policies (hand-written SQL required). Since RLS is a Tier-0 invariant (partitioning §2) and the engine becomes a **second writer on the shared production DB**, the safest default is **Drizzle ORM** (or Kysely): transaction-scoped `set_config` is trivial, migrations are plain SQL (RLS policies natural), multi-schema is first-class. If the team overrides to Prisma: RLS SQL lives in separate hand-written migration files, tenant context only via `$extends` + interactive transactions, and the #23583 class of risk is accepted in the ADR.
**B — Email (C15).** Provider API behind a transport port; dev = file transport.
**C — OP library.** `oidc-provider` (panva) — OpenID Certified; refresh-token **rotation with reuse detection built in** (`refreshTokenRotation`); PKCE S256 required-by-default for public clients. Two configuration notes: (1) access tokens must be **JWTs** for offline JWKS verification — enable the JWT access-token format / resource indicators; (2) persistence via its adapter interface to the engine DB (one writer: the engine).
**D — NestJS + Fastify.** Production-viable (2–3× Express throughput in benchmarks); keep versions patched (a path-canonicalization advisory affected the Fastify adapter in 11.1.13) and keep the Express adapter as the documented fallback.
**E — Contract composition (C7).** Engine-owned script; inputs: runtime pinned spec (Python export, unchanged) + engine swagger export; output: `contracts/openapi.composed.v1.json` with `x-neryva-owner`; CI fails on unowned paths, manifest↔contract mismatch, or cross-source path collisions.
**F — Fernet/L4 (C12).** No maintained JS library (`fernet` npm is inactive; forks exist). Engine defers L4; if ever required, implement verify-only with `node:crypto` + Python-generated fixtures.

---

## 3. Engine build scope (module map — what this plan delivers)

| Module (`engine/src/`) | Routes | Guards | Ledger (spec + tracker) |
|---|---|---|---|
| `common/` (kernel) | `/health/{live,ready}` | — (the enforcement layer) | `kernel.md` (K-1…K-5, amended: K-3 scope per C11/C12) |
| `modules/identity` | `/auth/**`, `/.well-known/**` | public + PKCE; mints L1/L3-lite | `identity.md` (I-0…I-1d; L3-lite per C17) |
| `modules/organizations` | `/console/org/**` | L1 + membership roles + step-up | `organizations.md` (O-1…O-4) |
| `modules/console` | `/console/home`, product mounts, manifests/summaries | L1 + entitlement | `console.md` (C-1…C-4, C-2 per C7) |
| `modules/corporate` | `/public/**`, `/console/content/**` | none (rate-limit/honeypot) / staff | `corporate.md` (E-1…E-6) |
| `modules/agent-studio` (furniture) | `/console/agent-studio/**`, manifest/card | L1 + scopes + entitlement | `agent-studio.md` (S-1…S-5; S-2 route-moves cancelled per C10) |
| billing/metering (kernel service + views) | spend ingest, `/platform` usage/billing APIs | L3/L5 ingest; L1 views | `billing-metering.md` (B-1…B-5) |
| `modules/deployment` | `/console/deployment/**`, `/v1/deployments/**`, `deployment:` queue | L1 / L2 + scopes | `deployment-product.md` (D-1…D-5) |
| **Satellite-serving surfaces** (spread across identity/console/billing) | JWKS, key validation API, metering ingest, policy publish (versioned pull + push notify), manifest registry | L3/L5 | `agent-runtime.md` A-1…A-4 engine-side (C19) |

The auth map in `END-TO-END.md` §2 remains the behavioral specification for every engine-owned row.

---

## 4. Execution order (P0–P8; supersedes END-TO-END §3)

Dependency chain: **P0 → P1 → P2 → P3 → (P4 ∥ P6a) → P5 → P7 → P8**, with P6b–d (website work) riding P2/P4 completion. E-number mapping: E0→P0, E1→P1, E2→P2, E3→P3, E4+E5→P4, E6→P5, E7→P6, E8→P7, E9→P8.

### P0 — Recover, commit, align the tree (days; nothing starts before this)

1. **Verification pass on the studio repo** (`pytest -q`, `ruff check`, `mypy` — the pass `01-health-and-blockers.md` §6 calls for). Commit the 105-change batch in reviewable slices (security+migrations / observability+ops / CI+helm / SDKs+docs / litellm+llama-guard+dlp), then push.
2. **Engine repo:** commit the pending ledger/ADR-007 work, create its GitHub remote, push. **neryva_backend:** commit + push its 2 files. (C5)
3. **Tree alignment (one promotion commit, then move commits — order matters):**
   a. delete empty root `contracts/`, `ops/`, `sdks/`;
   b. `mv console/neryva-website corporate/neryva-website` (plain move — untracked by the studio repo);
   c. promote: `mv products/neryva_agent_studio/.git .git`; lift the studio root files (`AGENTS.md README.md CHANGELOG.md package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json eslint.config.js docker-compose.yml .github .gitignore .dockerignore .env.example .env.dev`) to the root;
   d. `git mv products/neryva_agent_studio/frontend console` (console/ is now free — the deprecated donor, `console/DEPRECATED.md`);
   e. `git mv products/neryva_agent_studio/widget products/agent-studio/widget`;
   f. `git mv` `contracts/ ops/ sdks/ evals/ data/ docs/` up to root;
   g. absorb the engine docs repo (push first — done in 2): remove `engine/.git`, `git add engine/docs` (history preserved on its remote);
   h. absorb corporate: after confirming both remotes hold full history, drop `.git` from `corporate/{neryva_backend,neryva-website}`, add `DEPRECATED.md` to neryva_backend;
   i. dedupe docs (C4): delete root `architecture/` and the root `docs/{final_analysis,dev}` duplicates — `engine/docs/` is canonical; root `docs/` keeps runtime-specific material only.
4. **Config alignment:** `pnpm-workspace.yaml` (`console`, `products/agent-studio/widget`), root `package.json` script paths, CI workflow paths (`backend/` → `products/neryva_agent_studio/backend`; add placeholder engine job), Dockerfile `COPY` lines, `.gitignore`, `pyproject.toml` package/pytest paths. **No `backend.app→engine.app` rewrite (C1).**
5. **Gates:** `from backend.app.main import app` → 103 paths (with corrected `PYTHONPATH`); import-health tests green; `pnpm install && pnpm build` console + widget; no stale-path greps; `git status` clean; root repo pushed.
6. **Hygiene (C20):** rename `neryva-wesbite` → `neryva-website` on GitHub; archive `Neryva/website/`; move `neryva_product_12/` under research; update `Neryva/docs/REPO_MAP.md` + `ARCHITECTURE.md` and the root `README.md` org map to the new tree.

### P1 — Engine bootstrap + deploy lane + email (M1 + K-1/K-2 + A-0-proxy + corporate E-1)

- NestJS + Fastify skeleton in `engine/src` (`main.ts`/`app.module.ts` assembly-only); joins the pnpm workspace; ESLint + `eslint-plugin-boundaries` + `dependency-cruiser`; CI job (lint/typecheck/Jest); `/health/live` + `/health/ready` scaffold. [K-1, K-2]
- **ORM decision spike (C16)** with the RLS failing-test gate; record the decision as an ADR-005 addendum.
- **Deploy lane (C8):** engine Dockerfile + compose service + reverse proxy with the route table (`/v1`, `/surfaces`, `/internal` → runtime; `/*` → engine); proxy health checks + documented flip-back.
- **Email service (corporate E-1):** transport port + provider decision (C15), templates (login code, invite, opt-in), delivery audit, rate-limited send. Resolves doc-06 Q1.
- **Gates:** CI green; `/health/live` through the proxy; staging email send (sandbox provider) verified.

### P2 — Identity (I-0 → I-1d)

Per `identity.md`, implemented in TS with the C11/C14/C17 amendments:
- **I-0** models per doc-06 §11 (TS migrations `eng-0001…`; ownership map entries; `MODULES__IDENTITY_ENABLED=false`); seed `oauth_clients` (console, website).
- **I-1a** argon2id + single-use hashed email codes (per-account + per-IP buckets, enumeration-resistant) — uses P1 email.
- **I-1b** the OP: `oidc-provider` with DB adapter; Authorization Code + PKCE required; **JWT access tokens** (§2 C note); JWKS dual-key rotation (≥ 2× access TTL; production refuses auto-generated keys); refresh rotation + reuse tripwire; RFC 7009 revoke; discovery.
- **I-1c** `L1JwtGuard` (JWKS-cached verify + `sid` deny-list, Redis TTL ≤ access TTL, registry fallback).
- **I-1d** cutover: minimal web-app login page (C14); `operator_sessions` data migration (TS script: runtime table → `oauth_sessions`; old tokens honored until the satellite's A-2); break-glass bootstrap key verified + alerted.
- **Gates:** OP conformance tests (PKCE rejection, rotation, reuse tripwire, JWKS rotation); e2e login/logout/revoke on staging; rollback = flag off.

### P3 — Organizations (O-1 → O-4)

Per `organizations.md`: schema (TS migrations; `api_keys` additive columns via **Alembic 0017 in the Python repo** — the one sanctioned Python-side migration, C6; ownership map marks the dual-write window that opens here and closes at A-1) → repositories + entitlement state machine (audited transitions) → access guards (membership roles × entitlement × scopes; **TS step-up MFA guard**, C11) → org admin API (`/console/org/**`, contract-pinned) + personal-org auto-creation at signup + invite-only joins. **Gate:** invite→accept→role→revoke e2e; access-matrix row tests.

### P4 — Control plane + metering (C-1…C-4 + B-1…B-3, ∥ P6a)

- **C-1** manifest registry (`engine/products_manifests/*.yaml` + loader + bijection self-check); satellites register via the same schema.
- **C-2' contract composition v2 (C7):** engine-owned composition script → `contracts/openapi.composed.v1.json`; `x-neryva-owner` on every path (runtime's 103 tagged from the merged spec); CI bijection + collision checks; SDK facets later.
- **C-3** `/console/home` (manifest + entitlement state + cached summaries; fixed card schema; fake-product CI test).
- **C-4** org furniture mounted into home/nav payload.
- **L3-lite (C17):** client-credentials grant for `kind=service` clients + audience validation — unblocks satellite handovers and B-1 ingest auth.
- **B-1** engine metering ingest (idempotent by event id; `product_tag`+`project_id` required; L3/L5 auth) writing **engine-owned** spend tables; engine quota engine with `platform>tenant>product>project>surface>end_user` (unset levels = current behavior — parity test).
- **B-2/B-3** ledgers per (org × product) + `billing_invoices`; usage/billing APIs (`/platform`-serving; rollup is the only cross-product total).
- **Gates:** composed contract carries owners; CI red on a deliberate unowned route; ingest idempotency; quota parity; `/console/home` renders owned/trial/none/past_due.

### P5 — Agent Studio registration + satellite handover surfaces (S-1…S-5 + A-1…A-4 engine-side)

- **S-1…S-3** engine furniture: `agent_studio` manifest (faces: control=true, runtime=**external** — satellite base URLs per ADR-006), `studio-team`/`studio-enterprise` entitlements, summary provider (engine metering + satellite observability feed; empty-KPI fallback).
- **S-4** studio console APIs: per-project usage slices (B-3), project-scoped key management (O-1 columns; engine key service writing `api_keys` during the documented dual-write window), deep links to satellite-served surfaces.
- **A-1 (engine side)** key/token authority: key issuance/revocation service + validation API for satellites (short-TTL cache semantics documented; break-glass read-only fallback documented for the satellite).
- **A-2 (engine side)** JWKS + `sid` revocation propagation ready for satellite consumption.
- **A-3 (engine side)** metering receiving: B-1 ingest is the target; reconciliation report endpoint (dual-write totals comparison).
- **A-4 (engine side)** policy/config publishing: policy sets + guardrail profiles + quota profiles stored and published (versioned pull + push notify); audit chain continuity across the wire.
- **A-5** superseded-subsystem retirement lists (per-ledger) handed to the satellite track.
- **Gates:** key created in console validates on the satellite (when its side lands) — engine gate: validation API contract test; home card renders all states; reconciliation report shape frozen.

### P6 — Corporate completion + web-app dependencies (E-2c…E-6c; was E7)

- **P6a (early, ∥ P4)**: public endpoints + tables (`/public/{contact,newsletter,careers}`; rate-limit + honeypot + idempotency; TS migrations).
- **P6b** content admin (`/console/content/**`, staff role; build-time export for static rendering).
- **P6c** website re-point (needs P2 login + P6b): forms → `/public/*`; local auth pages removed (login = Neryva Account).
- **P6d** Mongo→Postgres data migration (newsletter/contact; row-count reconciliation) → two-week zero-traffic verification → neryva_backend retirement checklist.
- *(The `/platform` + `/studio` web-app build itself is the frontend track — unblocked by P4/P5.)*
- **Gates:** abuse-path tests; reconciliation signed off; retirement checklist complete.

### P7 — Deployment product (D-1…D-5; requires A-1)

Net-new TS module per `deployment-product.md`: schema (schema `product_deployment`; envelope secrets) → manifest + entitlement + summary stub → console read APIs → the workflow (`deployment.run` on the BullMQ `deployment:` namespace; stage gates via the engine policy service; agent-config snapshot via the public contract with L3; L5 runner identities — **engine-minted, post-A-1**) → canary/rollback, alerts, cost, secrets vault. **Gate:** promote→canary→rollback e2e with stubbed gateway; DLQ path tested.

### P8 — Hardening & completeness (was E9)

Per-product Postgres schemas for TS-owned product tables; startup self-checks (route↔manifest bijection, flag matrix, migration-ownership consistency) enforced; DR drill + ops updates for every new surface; OWASP pass on `/public`; load test per namespace at GA; docs sweep; full suite + composed-contract audit; SOC 2 observation window starts when the pilot-blocking surface ships. **Gate:** completeness matrix below fully green.

---

## 5. Explicitly out of scope (other tracks, dependency-noted)

| Track | Owner doc | Engine dependency |
|---|---|---|
| Agent Studio backend TS rebuild (A-6) | `agent-studio-backend.md` + `ledger/agent-runtime.md` | Consumes P5's handover surfaces (A-1…A-4) + connection contract; parity flips ride the composed contract (P4) |
| Python runtime continuing work (optimizations OPT-0/3/5/6/7/9/10, feature waves) | `final_analysis/02–04` | None blocking; behavior changes must update `agent-studio-backend.md` in the same PR (ADR-007) |
| Web app (`/platform`, `/studio`, `/deployment` areas; console/ donor port) | `frontend-and-portal-plan.md` | Blocked by P2 (login), P4 (home/furniture APIs), P5 (studio pages), P7 (deployment pages) |
| Inference capability deployment | `ledger/inference.md` | Placeholder; pattern pre-registered |

---

## 6. Risk register (engine track)

1. **Two writers, one database** (engine + Python runtime during P3→A-1 and A-3 dual-write windows). Mitigation: the migration-ownership map is a CI-checked artifact (K-5); the only shared-table seams are `api_keys` (documented dual-write window) and reconciliation-report-checked spend flows.
2. **ORM/RLS mischoice** — mitigated by the P1 spike gate (failing-then-passing RLS test) before any module code.
3. **OP on the login critical path** — mitigated per doc-06 §10.6 (offline JWKS verification, break-glass key, L2/L4/L5 unaffected).
4. **Bus factor + backup discipline** — every repo remote'd and pushed at P0 (the engine's plan-of-record docs were one `rm -rf` from oblivion until then).
5. **Scope honesty** — P2/P4/P5 are multi-week phases each; the order is chosen so customer-visible value (login, console, org furniture) ships first and nothing big-bangs.
6. **Contract drift** — the composed contract + bijection CI (P4) is the single enforcement point; until P4 lands, engine routes stay out of the pinned runtime spec by construction (separate deployables, one proxy).

---

## 7. Completeness matrix (corrected)

- [x] Every engine namespace (kernel, identity, organizations, console, corporate, agent-studio furniture, billing-metering, deployment) has a phase and a ledger
- [x] Every satellite-serving surface (JWKS, key validation, metering ingest, policy publishing, manifest registry, L3-lite) has a phase (P4/P5)
- [x] Token layers: L1 built (P2), L2 guard vs shared table (K-3) with authority transfer at A-1, L3-lite (P4), L4 deferred-with-design (C12), L5 engine-minted post-A-1 (P7)
- [x] Migration authority rule stated (C6) and the single sanctioned Alembic migration identified (P3)
- [x] Contract composition designed for a two-source world (C7)
- [x] Auth map rows for all engine-owned routes inherit `END-TO-END.md` §2 as spec
- [x] Corrections traceable: C1…C20 each cite the contradiction and the authority that decides it
- [ ] Executed: P0 … P8 (checked off as phases complete — this file is the living tracker for the engine track)
