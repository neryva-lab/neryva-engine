# Engine — End-to-End Implementation Plan

**Date:** 2026-08-23 · **Scope:** EVERYTHING the engine is and will become — every module, every route, every auth path. Detail lives in the workstream plans (`dev/*/plan.md`); this file is the complete map and the single execution order. Paths are studio-repo-relative (`backend/…`); after tree alignment they become `engine/…`.

**Dispositions used below:** `KEEP` (platform service, unchanged), `EXTEND` (exists, gains capabilities per plan), `MOVE→PRODUCT` (route ownership moves to a product module), `NEW` (to be built).

---

## 1. Complete engine inventory (enumerated from the tree, 2026-08-23)

### 1.1 Entry points
| Item | What | Disposition | Plan |
|---|---|---|---|
| `app/main.py` | FastAPI app assembly, lifespan, health | EXTEND (mounts: identity OP, /public, /console/home, product routers via manifests) | E2/E5 |
| `app/worker/main.py` | worker entry | EXTEND (namespaced queues) | P-3 |

### 1.2 API routes — all 19 files
| Route file | Surface | Disposition | Plan |
|---|---|---|---|
| `api/routes/console.py` | operator console APIs | EXTEND → becomes `/console/home` + org furniture mount | control-plane |
| `api/routes/operator_auth.py` | operator login/session mint | **REPLACED** by the identity OP (cutover, dual-run) | identity I-1d |
| `api/routes/conversations.py` | chat endpoints (3604 lines) | MOVE→PRODUCT (`products/agent_studio`), paths unchanged | agent-studio S-2 |
| `api/routes/openai_compat.py` | public OpenAI-compatible API | MOVE→PRODUCT (paths `/v1/**` unchanged) | S-2 |
| `api/routes/surfaces.py` | end-user surface endpoints (L4) | MOVE→PRODUCT | S-2 |
| `api/routes/sessions.py`, `threads.py` | session/thread APIs | sessions MOVE→PRODUCT; threads stays platform (engine runtime) w/ product views | S-2 |
| `api/routes/usage.py` | usage views | EXTEND (product/project slices + rollup; billing routes) | metering M-3 |
| `api/routes/policies.py` | policy sets + publish + simulate | KEEP (governance) — stays platform | — |
| `api/routes/prompts.py`, `tools.py`, `model_catalog.py` | product admin views | MOVE→PRODUCT | S-2 |
| `api/routes/webhooks.py` | webhook subscriptions | KEEP platform (delivery machinery is Tier-1) | — |
| `api/routes/evals.py` | eval runs (ragas suite) | KEEP platform (evals:run permission exists) | — |
| `api/routes/traces.py` | observability traces | KEEP (staff/product shared) | — |
| `api/routes/harness.py` | operator harness workbench | KEEP (staff overlay) | — |
| `api/routes/operations.py` | ops plane (health/SLO/drill) | KEEP | — |

### 1.3 Identity & auth
| Item | What | Disposition | Plan |
|---|---|---|---|
| `api/dependencies/auth.py` | L2 keys, operator sessions, MFA proofs, tenant scoping | EXTEND (adds L1 JWT resolution; everything else stays) | identity I-1c |
| `modules/sso/oidc.py` | OIDC **RP** (external IdPs) | KEEP — becomes the inbound-federation side later (I-4) | identity |
| `modules/security/totp.py` | TOTP | KEEP (factor for step-up; webauthn later) | identity I-4 |
| `session/tokens.py` | L4 end-user tokens | KEEP (gains `end_users.account_id` link) | organizations O-1 |
| migrations `0009` (operator sessions), `0015` (agent identities, L5) | | KEEP; 0009 data migrates to `oauth_sessions` | identity I-1d |

### 1.4 Session engine & context stack (the runtime)
| Item | What | Disposition |
|---|---|---|
| `session/{coordinator,service,limits,hot_tier}.py` | durable session engine | KEEP |
| `context/` | context assembly | KEEP |
| `application/{compaction,memory,retrieval,ingestion,orchestration,validation,clearing}.py` | context/compaction/RAG stack | KEEP (retrieval upgrades = optimization roadmap OPT-5) |
| `infrastructure/db/threads.py` | thread store (+ `list_recent_messages` from this session) | KEEP |

### 1.5 Gateway (Tier-1, gains product partitions)
`gateway/{router,service,catalog,admission,cache,cooldown,fallback,ledger,quota,anomaly,types}.py` — KEEP; `quota.py` EXTEND (product/project levels), `router/service` EXTEND (per-product routing profiles/namespaces + `product` metric label). Plan: partitioning P-2/P-4. `adapters/llm` KEEP (provider adapters incl. LiteLLM).

### 1.6 Guardrails & safety
`modules/guardrails/*` (orchestrator with shadow mode — shipped this session, classifier, config, pii_engine, llama_guard, fastpath) · `modules/escalation`, `modules/grounding` · `application/redteam` · `adapters/dlp` — KEEP; EXTEND config with per-product profiles above the platform floor (partitioning Tier-1).

### 1.7 Governance & evidence
`governance/{rls,compiled,compliance,evidence,isolation,presets,promotion,residency,budgets,toolgate}.py` · `domain/{policy,safety}` · `application/policy_simulation` — KEEP (policy simulation shipped this session); RLS policies EXTEND to all new tables (identity/orgs/products/corporate).

### 1.8 Data plane & infrastructure
| Item | What | Disposition |
|---|---|---|
| `infrastructure/db/{models,repositories,manager,replicas}.py` | ORM (60+ models), repos (runtime-cache read-through, replica-routed spend reads — this session), replica router | EXTEND (new tables/repos per plans) |
| `alembic/versions/0001–0016` | migrations | KEEP; 0017–0022 allocated below |
| `infrastructure/cache/{manager,tenant_runtime}.py` | cache + namespaced runtime cache (this session) | EXTEND (product key prefixes) |
| `infrastructure/queue/manager.py` | priority/DLQ/scheduled queue | EXTEND (namespaces) |
| `infrastructure/patterns/{retry,circuit_breaker,rate_limiter}.py` | resilience primitives | KEEP |
| `infrastructure/{observability,keys,storage,stream}.py` | metrics, key custody, storage, streaming | KEEP |
| `adapters/{auth,tools,ticketing,tracing,vectorstore}.py` | integration adapters | KEEP |

### 1.9 Workers & jobs
`worker/{handlers,main,canary_monitor,quality_monitor,eval_extractor,retention}.py` + `schedule.default.json` · `application/{archive,cleanup,clearing,eval_replay,handoff,tenant_lifecycle}.py` — KEEP; EXTEND: `deployment.run` job type (namespace `deployment`), monitor jobs gain product labels. Plan: deployment D-4, partitioning P-3.

### 1.10 Settings, flags, ops, evals, contracts
`settings/{env,feature_flags}.py` EXTEND per plan flags · `ops/` (docker, helm, monitoring, scripts, statuspage, terraform, loadtest) KEEP (image COPY lines updated at tree alignment) · `application/evals/ragas_suite` + repo `evals/` KEEP · `contracts/openapi/openapi.v1.json` (103 paths) + `scripts/export_openapi.py` EXTEND (`x-neryva-owner` + bijection) · `sdks/` KEEP.

### 1.11 NEW (nothing exists today)
| Module | Plan |
|---|---|
| `modules/identity/` (accounts, OP, L1) | identity (E2) |
| org furniture (memberships/invites/projects/entitlements tables + repos + routes) | organizations (E3) |
| `app/platform/` (manifests, console home) + `products_manifests/*.yaml` | control-plane (E5) |
| `app/products/agent_studio/` | agent-studio (E6) |
| `app/products/deployment/` | deployment (E8) |
| `app/corporate/` (email first, forms, content) | corporate (E1/E7) |
| billing invoices + ledger views | metering (E5) |

---

## 2. The auth map — every surface, every token layer

**Layer key:** L1 console sessions (OP JWT) · L2 API keys · L3 service tokens · L4 end-user tokens · L5 agent identities. Every request additionally passes the deny-by-default policy engine and RLS underneath.

| # | Surface (route file / endpoint class) | Layer | AuthZ | Step-up? | Change |
|---|---|---|---|---|---|
| 1 | `operator_auth.py` (operator login) | — (mints sessions) | — | TOTP today | REPLACED by OP login (E2) |
| 2 | `console.py` (→ `/console/home`, org furniture) | L1 (today: operator sessions/L2) | membership roles (owner/admin/billing/dev/reader) + staff overlay | role assignment, purchases | identity I-1d + organizations O-3/O-4 |
| 3 | `/auth/*` OP endpoints (NEW) | public + PKCE | client registry only | — | E2 |
| 4 | `/public/*` corporate forms (NEW) | none | IP rate-limit + honeypot | — | E7 |
| 5 | `conversations.py` | L2 (+L4 via surfaces) | tenant scope + `studio` entitlement | — | S-4 entitlement wrap |
| 6 | `openai_compat.py` | **L2 only** (documented) | key role/scopes + quotas + entitlement | — | S-3/S-4 |
| 7 | `surfaces.py` | L4 | surface binding, end-user caps | — | none |
| 8 | `sessions.py` | L2 (product views) | as conversations | — | S-2 |
| 9 | `threads.py` | L2/L4 per path | tenant scope | — | stays platform |
| 10 | `policies.py` | L2 (policies:read/write) | RBAC (exists) | **publish requires MFA proof (exists)** | none |
| 11 | `prompts.py` / `tools.py` / `model_catalog.py` | L2 | product scopes post-S-2 | — | MOVE→PRODUCT |
| 12 | `webhooks.py` (management) | L2 | RBAC (exists) | — | none (deliveries = signed outbound, no authn layer) |
| 13 | `evals.py` | L2 | `evals:run` (exists) | — | none |
| 14 | `traces.py` | L1/L2 | staff + product views | — | none |
| 15 | `harness.py` | L1/L2 | staff overlay (`require_operator`) | — | none |
| 16 | `operations.py` (health/SLO/DR) | L1/L2 + public liveness | staff overlay; `/health/live` public | — | none |
| 17 | `usage.py` → `/platform/{usage,billing}` | L1 (+L2 legacy) | billing views: owner/admin/billing; rollup read-only | — | M-3 |
| 18 | `/console/{agent_studio,deployment}/**` product pages APIs | L1 | membership + product scope + entitlement state (403/402 semantics) | privileged acts | S-4/D-3 |
| 19 | Worker jobs (internal) | L5 for runners; queue-internal otherwise | job type allowlist; namespace isolation | — | D-4, P-3 |
| 20 | Cross-product reads (studio↔deployment) | L3 token exchange | acting product recorded in audit | — | 06 I-3 (E8 needs it; may defer via internal read) |

**Rules:** a token from one layer is never accepted on another (prefix/aud/verification separation — already the codebase pattern). No credential store outside `modules/identity`. Safety floor applies to every product context.

---

## 3. End-to-end execution order (phases E0–E9)

| Phase | Scope | Migrations | Done when |
|---|---|---|---|
| **E0 — Recovery & baseline** | reorganization-guide Stages 0–3 (commit the 103-file batch, promote `.git`, engine/ move, import rewrite); dedupe stale root `contracts/ops/sdks` copies | — | full test suite baseline recorded; `from engine.app.main import app` = 103 paths |
| **E1 — Email** | corporate E1 (SMTP service + templates) | — | identity's dependency live |
| **E2 — Identity** | I-0 skeleton → I-1a email-code login → I-1b OP core → I-1c L1 resolution → I-1d console cutover; Δ1 spectrum | 0017, 0018 | console login via OP; operator sessions migrated; break-glass verified |
| **E3 — Organizations** | O-1 schema → O-2 repos/state machine → O-3 access enforcement (roles × entitlements, Δ5) → O-4 org admin API | 0019 | invite→accept→role→revoke e2e test green |
| **E4 — Partitioning** | P-1 import-linter+CI → P-2 quota levels → P-3 queue namespaces → P-4 cache/metric namespaces → P-5 manifest route enforcement | — | CI red on violating import; quota parity test (existing tenants unchanged) |
| **E5 — Control plane + metering** | C-1 manifests → C-2 contract owners+bijection → C-3 home+summaries+fake-product test → C-4 furniture mount; M-1 spend dimensions → M-2 quota wiring → M-3 ledgers+usage/billing APIs → M-4 chargeback per product | 0021 | `/console/home` renders 3 states; contract carries owners; ledgers slice per product |
| **E6 — Agent Studio productization** | S-1 skeleton+manifest → S-2 route moves (paths unchanged) → S-3 metering tag → S-4 entitlement+summary card | (0021 shared) | 103-path set byte-identical; card live; spend tagged `agent_studio` |
| **E7 — Corporate completion + retirement** | E2 forms → E3 content admin → E4 website re-point → E5 Mongo→Postgres migration → E6 neryva_backend retirement | 0020 | neryva_backend archived; forms live on engine |
| **E8 — Deployment product** | D-1 schema → D-2 manifest/entitlement/summary → D-3 console APIs → D-4 worker workflow (L5 runners, policy gates) → D-5 canary/alerts/cost/secrets | 0022 | pipeline promote→canary→rollback e2e with stubbed gateway |
| **E9 — Hardening & completeness** | P-6 per-product Postgres schemas (with module moves); DR drill + ops updates for new surfaces; docs sweep; full suite + contract audit | — | §4 matrix fully green |

Dependency chain: E0 → E1 → E2 → E3 → (E4 ∥ E5 after E3) → E6 → E8; E7 parallel from E1. Frontend work (portal `/platform`, `/studio` port) tracks E5/E6 — see `architecture/frontend-and-portal-plan.md` (not engine scope).

---

## 4. Completeness matrix (the "nothing missing" proof)

- [x] Every route file (19/19, §1.2) appears in the auth map (§2 rows 1–18 + worker row 19)
- [x] Every engine area in §1 (entry, identity, session/context, gateway, guardrails, governance, data plane, workers, settings/ops/evals/contracts) has a disposition and a phase
- [x] All five token layers: L1 issued/verified (E2), L2 unchanged, L3 specified (row 20; built at I-3 trigger), L4 unchanged (+account link O-1), L5 unchanged (used by E8)
- [x] Migrations 0017 (identity), 0018 (session migration), 0019 (orgs), 0020 (corporate), 0021 (metering/studio tagging), 0022 (deployment) — sequential, no collisions
- [x] Every workstream plan (`dev/*/plan.md`) is referenced by at least one phase
- [x] Auth for every NEW surface included (OP, /public, product consoles, worker runners, cross-product reads)
- [ ] Executed: E0 … E9 (checked off as phases complete — this file is the living tracker)
