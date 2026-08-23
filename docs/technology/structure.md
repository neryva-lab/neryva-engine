# Engine Structure — Repository & Source Layout

**Date:** 2026-08-23 · **Status:** plan of record (extends [`dev/modularity/plan.md`](../dev/modularity/plan.md) §1; incorporates the [ENGINE-EXECUTION-PLAN](../dev/ENGINE-EXECUTION-PLAN.md) corrections C1/C8/C10/C12)
**Scope:** the aligned `neryva_studio/` tree and the `engine/src` module architecture. The engine is **core only** (ADR-006) — see §5 for what deliberately does not live here.

---

## 1. The aligned repository tree (after P0 alignment)

One repo, `.git` promoted from the studio repository (plan P0):

```
neryva_studio/                          ← ONE git repository (remote: neryva-agent-studio)
├── engine/                             ← THE ENGINE — TypeScript/NestJS core (this tree, §2)
│   ├── docs/                           ← engine documentation (canonical for engine + architecture)
│   │   ├── architecture/               ← ADRs 001–007, console/, products/, partitioning, reviews…
│   │   ├── dev/                        ← END-TO-END, ENGINE-EXECUTION-PLAN, workstream plans
│   │   ├── ledger/                     ← one tracker per namespace (the progress law)
│   │   ├── technology/                 ← this file + technology.md (the stack plan of record)
│   │   └── agent-studio-backend.md     ← the satellite rebuild's behavioral reference (ADR-007)
│   ├── products_manifests/             ← C-1 manifest registry (agent_studio.yaml, deployment.yaml, …)
│   ├── src/                            ← engine source (§2)
│   ├── test/                           ← contract snapshots + ported acceptance tests
│   └── package.json                    ← member of the pnpm workspace
├── products/
│   ├── neryva_agent_studio/
│   │   └── backend/                    ← the Python runtime — REFERENCE + production until parity
│   │       │                              flips (ADR-007 D4). Never moves; never becomes engine/
│   │       ├── app/ … 16 Alembic migrations (0001–0016; 0017 = the one sanctioned additive)
│   │       └── tests/                  ← the acceptance spec for its TS replacement
│   └── agent-studio/
│       └── widget/                     ← studio product's end-user surface (L4)
├── console/                            ← DEPRECATED studio frontend (donor for /studio/** pages;
│   └── (former frontend/)                 ported into the web app, then deleted — ADR-004 Am.1)
├── corporate/
│   ├── neryva-website/                 ← THE one web app: marketing + /platform + /studio + /deployment
│   └── neryva_backend/                 ← DEPRECATED reference (duties rebuilt in modules/corporate)
├── contracts/                          ← openapi.v1.json (runtime, pinned) + openapi.composed.v1.json (P4)
├── sdks/   ops/   evals/   data/       ← shared plane assets (moved up from the studio repo)
├── docs/                               ← runtime-specific docs only (implementation/, notes/, ops/, portal/)
│                                          — engine/architecture docs are NOT duplicated here (plan C4)
├── .github/  package.json  pnpm-workspace.yaml  pyproject.toml  tsconfig.json
├── eslint.config.js  docker-compose.yml  AGENTS.md  README.md  CHANGELOG.md
└── (ops/ carries the reverse-proxy route table: /v1,/surfaces,/internal → runtime; /* → engine — plan C8)
```

Invariants of this tree: the Python backend's path and imports never change (C1); `engine/` and `products/neryva_agent_studio/backend` are **separate deployables forever** (ADR-006 D3); no second copy of the architecture docs exists anywhere (C4).

---

## 2. The engine source tree (`engine/src`)

```
engine/src/
├── main.ts                    # bootstrap ONLY: Fastify adapter, global prefix, listen
├── app.module.ts              # assembly ONLY: imports module registries — no logic, ever
├── common/                    # THE SHARED KERNEL (locked list, §3)
│   ├── auth/                  #   guards: L1Jwt · L2ApiKey · L3Service · StepUpMfa
│   │                          #   (L4EndUserToken deliberately absent — plan C12)
│   ├── policy/                #   deny-by-default interceptor + entitlement guard factory
│   ├── audit/                 #   hash-chained audit emitter (Python AuditRepository semantics as spec)
│   ├── infra/                 #   db factory (chosen ORM + RLS tenant-context helper), redis,
│   │                          #   bullmq factories, storage, email transport
│   ├── http/                  #   error envelope, request-id, idempotency, rate-limit decorators
│   ├── health/                #   terminus: /health/live public, /health/ready aggregates modules
│   └── config/                #   typed env + per-module flags (MODULES__<NAME>_ENABLED)
├── modules/
│   ├── identity/              # accounts, OP (oidc-provider), sessions, L3-lite   [ledger: identity]
│   │   ├── accounts/          #   argon2id credentials, email one-time codes, recovery
│   │   ├── provider/          #   the OP: authorize/token/jwks/userinfo/logout/revoke + discovery
│   │   └── sessions/          #   oauth_sessions registry, refresh families, sid deny-list
│   ├── organizations/         # memberships, invites, projects, entitlements      [ledger: organizations]
│   ├── console/               # manifests, /console/home, summaries, org mounts   [ledger: console]
│   ├── corporate/             # email service, /public forms, content admin       [ledger: corporate]
│   ├── billing/               # metering ingest + quota engine + ledgers + bills  [ledger: billing-metering]
│   ├── agent-studio/          # product FURNITURE only (manifest, card, keys,
│   │                          # per-project usage views) — not the runtime        [ledger: agent-studio]
│   └── deployment/            # product #2: pipelines, environments, workflow     [ledger: deployment-product]
└── test/                      # contract snapshots + ported acceptance tests
```

**There is no `src/runtime/`.** Earlier layout drafts carried a runtime-port area from the strangler plan; ADR-006/007 removed it — the session engine, LLM gateway, guardrails, and context stack belong to the Agent Studio satellite, never to the engine (see §5).

### 2.1 Inside every module (the internal shape & public interface)

Every module under `engine/src/modules/<name>/` conforms to the bounded-context pattern:

```
modules/<name>/
├── <name>.module.ts           # registers only its own controllers/providers; imports only common + public modules
├── <name>.public.module.ts    # exports ONLY the public service interface for other platform modules
├── <name>.public.service.ts   # strictly typed public interface methods (entities/repos never leak)
├── controllers/               # confined to the module's route namespace (§4.1)
├── services/                  # internal business logic & state machine implementations
├── repositories/              # ORM models/queries for OWNED tables only (migration-ownership map)
├── dto/                       # request/response validation shapes (contract snapshot source)
├── guards/                    # module-specific guard composition (role × entitlement × scope)
└── README.md                  # purpose, routes, queues, tables, flags, owner
```

---

## 3. The shared kernel — locked list

Config · logger · ORM/Redis/BullMQ/storage/email factories (incl. the RLS tenant-context helper) · the auth guards (`L1Jwt`, `L2ApiKey`, `L3Service`, `StepUpMfa`) · policy/entitlement interceptors · audit emitter · error envelope + request-id + idempotency · rate limiting · health/self-checks · metrics.

Rules (enforced by `eslint-plugin-boundaries` + `dependency-cruiser` in CI — kernel ledger K-2):

1. **The kernel imports no module; modules import the kernel + allowed public interfaces only.**
2. **Platform modules (`identity`, `organizations`, `console`, `billing`, `corporate`) may inject other platform modules' public interfaces (`<name>.public.service.ts`).**
3. **Product modules (`agent-studio`, `deployment`) never inject anything product-side** — cross-product reads go through the public contract with an L3 service token (partitioning rule).
4. Additions to the kernel require an ADR.

---

## 4. Multi-Dimensional Namespace Encapsulation

The architecture formally partitions namespaces across **five distinct dimensions** (HTTP routes, message queues, cache keys, database schemas, and telemetry):

### 4.1 Route Namespaces (HTTP / REST / OIDC)

| Namespace | Guard | Owner module | Notes |
|---|---|---|---|
| `/auth/**`, `/.well-known/**` | public + PKCE | `identity` | the OP itself; authorize/token/jwks/userinfo; RFC 7009 revoke; discovery |
| `/public/**` | none (IP rate-limit + honeypot + idempotency) | `corporate` | contact, newsletter, careers, public content reads |
| `/console/home`, `/console/org/**` | L1 + membership roles | `console` / `organizations` | org home, members, invites, projects, audit; step-up on privileged acts (Δ5) |
| `/console/billing/**`, `/console/usage/**` | L1 + `(owner\|admin\|billing)` | `billing` | per-product/project usage slices, consolidated rollup, invoices & ledgers |
| `/console/{product}/**` | L1 + membership + product scope + entitlement | product modules (`agent-studio`, `deployment`) | `/console/agent-studio/**`, `/console/deployment/**`; 403/402 semantics |
| `/v1/deployments/**` | L2 (`deployment:operate` scope) | `deployment` | the engine's only `/v1` surface — `/v1/**` at large is the satellite's |
| `/internal/metering/spend` | L3 Service Token | `billing` | high-throughput spend-event ingestion endpoint for satellites |
| `/internal/**` | L3/L5/staff overlay | `common` / `ops` | internal runner callbacks, test harness, disaster recovery drills |
| `/health/{live,ready}` | public liveness; ready aggregates probes | `common` (health) | readiness = all enabled modules green |

*Satellite Route Surfaces (routed via reverse proxy directly to `agent-runtime`):*
- `/v1/**` (OpenAI-compatible endpoints: `/v1/chat/completions`, `/v1/models`, etc. — L2 API key)
- `/surfaces/**` (Widget & client-side end-user chat sessions — L4 end-user token)

### 4.2 Queue Namespaces (BullMQ on Redis)

All background jobs run in isolated queue namespaces formatted as `{module}:{queue_name}`:

| Queue Namespace | Owner Module | Workers / Job Types |
|---|---|---|
| `billing:spend-events` | `billing` | Micro-batching spend events into PostgreSQL ledgers |
| `corporate:email-dispatch` | `corporate` | Transactional email delivery (login codes, invites, confirmations) |
| `deployment:pipeline-runs` | `deployment` | Pipeline stage evaluations, policy checks, canary rollout orchestrations |
| `identity:session-cleanup` | `identity` | Expired grant tokens, retired refresh families, stale sessions cleanup |
| `organizations:invites` | `organizations` | Expired invite reaping and notification triggers |

### 4.3 Cache Key Namespaces (Redis)

All Redis keys adhere to the structured hierarchical prefix format `neryva:{module}:{scope}:{identifier}`:

| Key Pattern | Owner Module | Purpose / Invalidation |
|---|---|---|
| `neryva:identity:sessions:{sid}` | `identity` | L1 active session metadata and immediate revocation deny-list |
| `neryva:identity:jwks` | `identity` | Cached public JWKS key set for offline token validation |
| `neryva:identity:code:{email}` | `identity` | Single-use email one-time login codes (60s TTL, attempt-capped) |
| `neryva:organizations:tenants:{slug\|id}` | `organizations` | Tenant metadata & status read-through cache |
| `neryva:organizations:entitlements:{org_id}:{product}` | `organizations` | Cached product entitlement state (`trial`, `active`, `past_due`) |
| `neryva:billing:quotas:{org_id}:{product}:{project}` | `billing` | Atomic quota counters for sub-millisecond gateway reservations |
| `neryva:console:summaries:{org_id}:{product}` | `console` | Aggregated product summary KPI cards (60s TTL) |
| `neryva:corporate:rate-limit:{ip}` | `corporate` | Sliding-window IP rate limit counters for `/public/*` endpoints |

### 4.4 Database Schema Namespaces (PostgreSQL Multi-Schema + RLS)

Target layout isolates module domains into distinct PostgreSQL schemas, all protected under PostgreSQL Row-Level Security (RLS) via the shared tenant-context session variable `app.current_tenant`:

| Schema | Owner Module | Tables |
|---|---|---|
| `identity` | `identity` | `accounts`, `account_credentials`, `account_recovery_codes`, `account_identities`, `oauth_clients`, `oauth_sessions`, `oauth_refresh_tokens`, `oauth_grants` |
| `organizations` | `organizations` | `tenants`, `org_memberships`, `org_invites`, `projects`, `product_entitlements` |
| `billing` | `billing` | `spend_events`, `billing_ledgers`, `billing_invoices` |
| `corporate` | `corporate` | `contact_submissions`, `newsletter_subs`, `career_applications`, `content_posts` |
| `product_deployment` | `deployment` | `pipelines`, `pipeline_stages`, `environments`, `deployments`, `deployment_events`, `secrets` |
| `public` | `common` | `audit_events`, shared base extensions |

### 4.5 Telemetry & Observability Namespaces (OpenTelemetry & Prometheus)

Every metric, log, and trace span carries the standardized label taxonomy:
- `module`: The emitting module (`identity`, `organizations`, `billing`, `console`, `corporate`, `deployment`, `agent-studio`)
- `product`: The product context (`agent_studio`, `deployment`, `chat`, `platform`)
- `tenant_id` & `project_id`: Scoping dimensions for multi-tenant isolation and per-project drilldowns
- `route`: Pinned contract path identifier

---

## 5. What deliberately does NOT live in the engine

| Never here | Lives instead | Authority |
|---|---|---|
| LLM gateway, provider adapters, guardrail stack, session/thread engine, context/compaction/memory/retrieval, orchestration loop, tools/MCP, escalation/handoff, governance *enforcement* | the Agent Studio backend satellite (today Python; then its from-scratch NestJS rebuild) | ADR-006 D1/D3, ADR-007 D2, `agent-studio-backend.md` §3–4 |
| Product UX code, widget, marketing anything | product plane (web app, widget) | ADR-004, org plan §6.1 |
| Second credential store, second quota brain, second policy decision-maker | nowhere — the engine is the single one of each | ADR-006 D2 (the four-part connection contract) |
| Alterations to Python-owned tables | the Python repo's Alembic (only via a sanctioned additive migration) until ownership transfers at A-1/A-2 | plan C6, ADR-005 D3 |

If a piece of satellite logic ever feels engine-worthy, that is an ADR-level act (Rule of Two, partitioning §4) — never a quiet move.
