# Neryva Engine Implementation Ledger

## Document status

| Field | Value |
|---|---|
| Source of truth | `engine_architecture.md` (589 lines), `engine_data_and_lifecycle.md` (462 lines), `engine_implementation_plan.md` (727 lines) |
| Companion boundaries | `../main.md` (Engine = system of record, Studio = execution plane), `../agent_studio/agent_studio_architecture.md`, `../neryva_mcp/neryva_mcp_implementation_plan.md` |
| Scope | Engine control plane and system of record â€” authority, tenancy, conversations, runs, events, knowledge, billing, lifecycle, audit |
| Out of scope | Agent Studio runtime internals (separate repo/ledger), generic public third-party API, provider-side conversation store as canonical |
| Ledger type | Phase-gated execution tracker â€” one checkbox = one verifiable deliverable with evidence |
| Rule | No phase may be marked `DONE` without its exit-gate evidence in CI, migration history, or an operational drill log. Do not start a later phase before the previous phase's exit gates are `DONE`. |
| Date / snapshot | 2026-09-01 â€” codebase at `engine@0.1.0`, 19 drizzle files (18 logical `0001`â€“`0018` + duplicate `0009` â€” see Â§3.4), 13 feature modules, 52 engine-owned tables (`ownership-map.json:1`) |

> This ledger **replaces** the legacy `engine_implementation_plan.md` task ordering only in granularity and verification. `engine_implementation_plan.md:711` (`threat model -> identity/RLS -> assistants -> conversations/runs -> Neryva MCP -> outbox/workers -> files/knowledge -> billing -> lifecycle -> hardening`) remains the critical path. This ledger expands each phase into atomic checkable tasks and grounds them against `src/` as of 2026-09-01.

---

## 1. How to use this ledger

1. Work strictly in phase order. Each task cites the authoritative spec section and the current file(s) to change.
2. A task is `DONE` only when **code + migration + test + evidence** land together:
   - `code`: file path + line range
   - `migration`: `drizzle/00NN_*.sql` (immutable after merge, `ownership-map.json:1` owner = `engine-ts`)
   - `test`: unit / integration / RLS / isolation / contract / property / chaos â€” whichever the exit gate names
   - `evidence`: CI log, `EXPLAIN` plan, restore/replay drill recording, or `ops/runbooks/*.md` entry
3. Any new organization-owned table or public route must satisfy the Phase 0 gate before merge: request schema + response schema + authorization declaration + tenant-isolation test + `retention_class` + lifecycle policy. See `engine_implementation_plan.md:68-73`.
4. Treat `engine_architecture.md:570-584` (12 non-weakening decisions) as invariant gates from Phase 1 onward â€” a PR that violates them is blocked even if its local tests pass.

---

## 2. Architecture delta â€” what the new architecture requires vs what exists

### 2.1 Authority

| Boundary | New architecture | Current `src/` |
|---|---|---|
| Conversations / messages / runs / durable events | Engine PostgreSQL is system of record `engine_architecture.md:34-38`, `engine_data_and_lifecycle.md:116-206` | **Absent** â€” no `conversations`, `messages`, `runs`, `run_events`, `event_cursors` tables, no sequence allocator, no SSE cursor |
| Assistant versions & policy snapshots | Immutable `assistant_version DRAFT->VALIDATING->VALID->PUBLISHED->RETIRED` `engine_data_and_lifecycle.md:89-113` | **Absent** as assistant domain; generic `published_configs`/`config_drafts` (`0007`/`0016`) covers platform config, not assistant model/tool/guardrail policy |
| Knowledge / artifacts / chunks / embeddings | Engine owns metadata + access state, object store owns bytes, index is derived `engine_architecture.md:296-306` | **Absent** â€” `StorageService` presigns only `src/common/infra/storage/storage.service.ts:43`; no `artifacts`, `upload_sessions`, `documents`, `chunks`, `embeddings`, no `purpose` enum |
| Memory | Explicit provenance/visibility/expiry, proposal != truth `engine_data_and_lifecycle.md:303-323` | **Absent** |
| Usage ledger | Append-only `usage_ledger` with compensating corrections `engine_data_and_lifecycle.md:324-342` | Partial â€” `billing.spend_events` (`0004`) is idempotent metering ingest, not a full ledger with `settled_cost`/`reversal_ref`/`reconciliation_state` |
| Neryva MCP authority | Engine validates lease epoch, idempotent `AppendRunEvent`/`CommitRunResult`, cheap `GetAuthorizedRunContext` `engine_architecture.md:357-371` | **Absent** in `engine/` â€” contract lives in `../products/neryva_mcp/neryva-mcp-contract` (sibling of `engine/`) and is complete there; engine has no ConnectRPC host, no capability interceptor |
| Outbox / inbox | Transactional `PENDING->CLAIMED->PUBLISHED->RETRY_WAIT->DEAD_LETTER` + `inbox (consumer+event_id)` `engine_data_and_lifecycle.md:219-255` | **Absent** as generic primitive â€” only per-feature `config_notifications`/`webhook_deliveries` |

### 2.2 Current strengths to preserve (do not rewrite)

- **Tenancy & membership** â€” `src/modules/organizations/*` (7 controllers, RLS on `org_memberships`/`org_invites`/`projects`/`product_entitlements`, caps `ORG_MAX_PENDING_INVITES`/`ORG_MAX_MEMBERS`, staged `org_deletions`) is **production complete** per Phase 2.
- **Identity & sessions** â€” `src/modules/identity/*` (OIDC provider, `oidc-provider` adapter `0001`/`0010`, Argon2, TOTP, social, action tokens `0010`/`0018`, `SESSION_REGISTRY_PORT`/`SERVICE_CLIENT_PORT`) is **95%** (SAML via IdP intentionally deferred).
- **Config publishing** â€” `src/modules/config-publish/*` (`published_configs`/`config_drafts`/`config_notifications`, advisory-lock publish, hash + rollback lineage, drift detection) is **the reference implementation** for immutable-version publish â€” generalize, don't replace.
- **Kernel & observability** â€” `src/common/infra/db/db.service.ts:54` (`withOrg`/`withBypass`), `src/common/audit/audit.service.ts:12` (byte-identical chain), `src/tracing.ts:5` (OTel first), `src/main.ts:5` (bijection check `routeBijectionService.verify`), `common/observability/*` â€” keep and harden.
- **Satellites / deployment / webhooks / notifications** â€” satellite fleet control and product deployment are mature as *products*; they are not the Engine's conversation plane and must not be conflated (see Â§3.3).

---

## 3. Current implementation inventory (factual, 2026-09-01)

### 3.1 Runtime topology

Single NestJS/Fastify monolith `src/main.ts` + `src/app.module.ts:1`. All modules share one release artifact and one `Pool`. No `engine-api` / `engine-worker` / `engine-dispatch` / `engine-jobs` role split yet `engine_architecture.md:16-32`. No Temporal dependency, no NATS, no pgvector. `package.json:45` has `bullmq`+`ioredis`+`pg`+`drizzle-orm` only.

### 3.2 Module registry

| Module | Flag `src/common/config/feature-flags.ts:52` | Tables owned (`drizzle/*.sql`, `ownership-map.json`) | HTTP surface | Completeness vs new spec |
|---|---|---|---|---|
| `common` (kernel) | always | none â€” appends `audit_events` chain | `GET /health/live`, `GET /health/ready`, `GET /metrics` | Kernel 80%: missing statement timeouts, read-only/worker DB roles, serializable-retry helper |
| `identity` | `IDENTITY` | `accounts`, `account_credentials`, `account_recovery_codes`, `account_identities`, `oauth_clients/sessions/refresh_tokens/grants`, `oidc_payloads`, `email_login_codes`, `account_action_tokens` (`0001`/`0008`/`0010`) | OIDC + login + account + social | 95% |
| `organizations` | `ORGANIZATIONS` | `org_memberships`, `org_invites`, `projects`, `product_entitlements`, `org_settings`, `org_groups/members`, `org_service_accounts`, `org_deletions` (`0002`/`0009`/`0012`) | 7 controllers (`/console/org/*`) | 100% tenancy |
| `console` | `CONSOLE` | `console_announcements` (`0009`) | home/status/audit/announcements + `ManifestRegistryService` + `RouteBijectionService` | Shell 80% â€” no assistant console |
| `billing` | `BILLING` | `billing.spend_events`, `billing.billing_invoices`, `billing.price_catalog` (`0004`/`0011`), `billing_credits/credit_applications/budgets/invoice_lines/adjustments` (`0014`) | metering L3, usage, invoices, budgets, Stripe webhook, price catalog | 65% â€” no full ledger/compensation/reconciliation |
| `agent-studio` | `AGENT_STUDIO` | `studio_project_keys` only (`0006`); key rows stay `python` `api_keys` until handover A-1 | `/console/agent-studio/*` furniture | **Legacy furniture** â€” 20%, name collides with new Agent Studio runtime |
| `deployment` | `DEPLOYMENT` | `product_deployment.*` 7 tables (`0005`/`0017`) + envelope-encrypted `secrets` | 38 console routes + runtime/internal | 90% as product, 0% as generic Engine role split |
| `keys` | `KEYS` | none yet (dual-write `python` `api_keys` until A-1) | `POST /internal/keys/validate*` L3 | 70% |
| `config-publish` | `CONFIG_PUBLISH` | `published_configs`/`config_drafts`/`config_notifications` (`0007`/`0016`) | draft/validate/publish/rollback/delivery + pull | 85% (exemplar) |
| `satellites` | `SATELLITES` | `satellites`, `satellite_heartbeats/incidents/counters`, `revocation_events` (`0007`/`0011`/`0015`) | heartbeat/revocations/quarantine (L3) | 95% as fleet, 0% as tenant isolation cell |
| `webhooks` | `WEBHOOKS` | `webhooks`, `webhook_deliveries` (`0011`) | outbound webhooks + `WebhookWorker` | 70% outbound only |
| `notifications` | `NOTIFICATIONS` | `notifications` (`0011`) | `auth/me/notifications` + `EventBus` fan-out | 80% |
| `staff` | `STAFF` | `staff_impersonations` (`0011`) | staff overview/org/account + impersonate | 75% |
| `corporate` | `CORPORATE` | `contact_submissions`, `newsletter_*`, `career_*`, `content_posts/revisions` (`0003`/`0013`) | 10 public routes + CMS/inbox + campaign worker | 90% CMS, unrelated to Engine core |

### 3.3 Collision to resolve before Phase 3

`src/modules/agent-studio` is **not** the new architecture's Agent Studio `agent_studio_architecture.md:42-55`. The new Engine must own `assistants`/`conversations`/`runs`/`events`/`knowledge`/`memory`; the new Studio owns Temporal execution. The existing module is satellite-side Studio product furniture (key bindings + KPIs). Track rename under `Phase 3 â€” Rename`.

### 3.4 Database â€” 19 files (18 logical + duplicate 0009), 52 engine-owned tables

`drizzle.config.ts:14` enumerates 14 schema sources; `drizzle/*.sql` contains `0001`â€“`0018` plus duplicate `0009_console_surface.sql` + `0009_org_furniture_dense.sql` (journal `drizzle/meta/_journal.json:8` + `:12` both `0009`, `when` 1761232800000 reused â€” out-of-order, violates `engine_data_and_lifecycle.md:406` `ordered, immutable after merge`). RLS is `ENABLE ROW LEVEL SECURITY` + `FORCE RLS` + `USING (org_id = current_setting('app.current_tenant',true) OR app.engine_bypass)` on 18 tenant tables `drizzle/0002_org_furniture.sql:68` â€” correct shape but **no pending `conversations`/`messages`/`runs`/`run_events`/`artifacts`/`documents`/`chunks`/`memory_items`/`usage_ledger`** families (`engine_data_and_lifecycle.md:89-353`). No table yet carries `retention_class` (required `engine_data_and_lifecycle.md:40-44`). IDs use `gen_random_uuid()` â€” spec prefers UUIDv7 `engine_data_and_lifecycle.md:22-28`. **P0 before Phase 3:** re-journal duplicate `0009` â†’ `0019` via `drizzle-kit generate` or manual ordered fix with monotonic `when`.

### 3.5 Tech divergence register (decide once, then enforce)

| Decision | Spec says | Current | Verdict for this ledger |
|---|---|---|---|
| SQL builder | Kysely + `pg` `engine_architecture.md:140` | `drizzle-orm` `src/common/infra/db/db.service.ts:1` | **Keep drizzle**. The fleet is 19 files / 52 tables deep on drizzle. Migrating to Kysely would churn every repo without moving any business invariant. Treat drizzle as the approved SQL-visible builder, enforce *SQL-first reviewed migrations*, `EXPLAIN` plans, and no generic repository hiding locks/transactions `engine_implementation_plan.md:99-105`. Record ADR `docs/architecture/engine/decisions/dec-001-drizzle-as-sql-builder.md`. |
| HTTP | Fastify JSON Schema `engine_architecture.md:136` | NestJS + Fastify adapter `src/main.ts:30` + Zod/class-validator pipes | **Keep NestJS/FastifyAdapter**. Enforce explicit route schemas, response filtering, and OpenAPI generation â€” the spec's invariant is *explicit schemas*, not framework name. Record ADR. |
| Primary ID | Opaque UUIDv7 `engine_data_and_lifecycle.md:22` | `gen_random_uuid()` (v4) | Green-field tables use UUIDv7 (`uuidv7` npm or `pg_uuidv7`); existing tables stay v4 â€” do not mass-rewrite IDs. |
| Cache/queue | Redis/Valkey + BullMQ today, NATS JetStream when durable fan-out needed `engine_architecture.md:143-144` | BullMQ + ioredis `src/common/infra/queue.service.ts:17`, in-process `EventBus` `src/common/events/event-bus.ts:1` | **Keep BullMQ + introduce generic outbox** before reaching for NATS. Add NATS at Phase 6 only when measured fan-out/replay requires it. |

---

## 4. Phase overview (12 phases â€” same critical path as `engine_implementation_plan.md:711-726`)

| Phase | Name | Goal | Depends on | Current % | New tables |
|---|---|---|---|---|---|
| **0** | Architecture, threat model & repo foundation | Enforceable repo rules before business features | â€” | 65% | none |
| **1** | Platform kernel & database safety | Shared kernel + tx/session/RLS discipline | 0 | 75% | none |
| **2** | Identity / organization / authorization hardening | Production tenancy closure & CSR controls | 1 | 85% | `authorization_policies` (optional) |
| **3** | Organizations, assistants, policies & publication | Immutable assistant versions pinned to runs | 2 | 15%* | `assistants`, `assistant_versions`, `policy_snapshots` (+ rename legacy `agent-studio`) |
| **4** | Conversations, messages, runs & canonical events | Durable conversation boundary + Engine run projection | 3 | 0% | `conversations`, `conversation_participants`, `messages`, `runs`, `run_events`, `event_cursors` |
| **5** | Neryva MCP authority & Studio integration | Engine half of `neryva.mcp.v1` without DB leakage | 4 | 0% engine-side (contract complete in `../products/neryva_mcp`) | `run_leases`, `run_idempotency`, `checkpoints`, `tool_effects`, `approvals`, `memory_proposals` (or mapped into Phase 4 tables) |
| **6** | Outbox / inbox / broker / async workers | Every async boundary durable & replay-safe | 5 (generic introduced at 4) | 0% generic | `outbox_events`, `inbox_events` |
| **7** | Files, uploads, knowledge & claim-check storage | Secure large-payload + rebuildable ingestion | 6 | 10% (presign only) | `artifacts`, `upload_sessions`, `documents`, `document_versions`, `chunks`, `embeddings` (+ pgvector) |
| **8** | Billing, quotas, entitlements & reconciliation | Immutable ledger + deterministic quotas | 7 | 60% | `usage_ledger` (or evolve `billing.spend_events`) + `provider_reconciliation_runs` |
| **9** | Audit, retention, export, legal hold & deletion | Data lifecycle as product capability | 8 | 40% | `retention_policies`, `legal_holds`, `export_requests`, `purge_tasks` |
| **10** | Enterprise operations & production hardening | ASVS, DR, SLOs, chaos | 9 | 30% | none (runbooks + dashboards) |
| **11** | Optional scale & isolation extensions | Only from measurement/contract | 10 | 0% | only when justified |
| *`config-publish` exemplar = 85% for *platform config* ; *assistant* domain = 15% |

---

## 5. Phased ledger â€” atomic tasks

> Each task line is `checkbox` + **bold ID** + spec citation + scope â†’ `files` â†’ exit signal. Check a box only when the signal is in `main`.

### Phase 0 â€” Architecture, threat model & repository foundation

*Objective: turn `engine_architecture.md` + `engine_data_and_lifecycle.md` into enforceable repo rules before any new business table.*

- [ ] **0.1** Cut Engine ADRs (index + records) â€” modular monolith & roles `engine_architecture.md:14-27`, tenant model + RLS `engine_architecture.md:263-285`, REST/OpenAPI contract `engine_architecture.md:322-355`, Neryva MCP authority integration `engine_architecture.md:357-371`, outbox/inbox & transport `engine_architecture.md:373-399`, migration policy `engine_data_and_lifecycle.md:406-420`, claim-check policy `engine_architecture.md:296-306`, identity provider integration `engine_architecture.md:146-147`, billing-ledger authority `engine_architecture.md:401-425`, retention/legal-hold/DR `engine_data_and_lifecycle.md:359-391` â†’ `docs/architecture/engine/decisions/*.md` â†’ review sign-off.

- [ ] **0.2** Publish STRIDE threat model covering `engine_implementation_plan.md:41-55` â€” browser/channel, public API, service identities (`agent-studio-runtime`/`engine-worker`/`billing-reconciler`), MCP capability tokens, PostgreSQL+RLS, object storage+signed URLs, queues/outbox/replay, provider/billing, support access â†’ `docs/architecture/engine/threat-model.md` + owners per high-risk control.

- [ ] **0.3** Data classification registry â€” public/internal/confidential/restricted customer content/credentials/security audit â†’ `docs/architecture/engine/data-classification.md`; every table column labeled by next migration review.

- [ ] **0.4** Toolchain baseline â€” pin Node LTS + TypeScript `strict` + pnpm + formatter/linter/typecheck/test/coverage commands + lockfile policy â†’ `package.json:9-16`, `tsconfig.json`, `eslint`, `vitest` â†’ `pnpm typecheck && pnpm lint` green.

- [ ] **0.5** Configuration schema hardening â€” typed immutable config loaded once at startup `src/common/config/env.ts:173` (`parseEnv(loadFromProcess())`) â†’ add fail-closed checks for missing secrets / invalid URLs / unsafe prod defaults / unsupported protocol versions `engine_implementation_plan.md:72` â†’ boot test.

- [ ] **0.6** Observability guardrails â€” redaction denylist + trace correlation (`request_id`/`trace_id`/`organization_id`/`run_id`) `engine_architecture.md:462-489` â†’ `src/common/observability/logger.ts`, `src/tracing.ts:17`, `src/common/observability/metrics.ts:1` â†’ no prompt/token/credential in logs/traces.

- [ ] **0.7** Development stack â€” PostgreSQL + MinIO/R2 + Redis/Valkey + optional NATS/Temporal `engine_implementation_plan.md:65` â†’ `ops/compose` or `ops/docker-compose.yml` â†’ `pnpm dev` brings full stack.

#### Exit gates â€” Phase 0

- [ ] Threat model has named owners and maps each high-risk control to a test or runbook.
- [ ] `pnpm typecheck && pnpm lint && pnpm test:unit` + `buf lint` (when contract is imported) pass on a clean checkout.
- [ ] Any PR adding a route without request/response schema + auth declaration + test is blocked in CI.
- [ ] Any PR adding tenant-owned data without `organization_id` + index plan + lifecycle policy + isolation test is blocked in CI.
- [ ] Config fails closed on every unsafe production default (exercises `env.ts:192-206` + new MCP keys).

---

### Phase 1 â€” Platform kernel & database safety

*Objective: shared kernel every module uses without becoming an abstraction maze `engine_implementation_plan.md:74-118`.*

- [ ] **1.1** Harden Fastify bootstrap `src/main.ts:26` â€” request ID + trace propagation + auth pre-handler + route schema registration + response serialization + error mapping + rate-limit hook + graceful shutdown + `GET /health/live` + `GET /health/ready` aggregating module checks `engine_architecture.md:115-130`.

- [ ] **1.2** Harden `DbService` `src/common/infra/db/db.service.ts:1` â€” bounded pool (`DATABASE_POOL_MAX` `env.ts:28`), statement/idle-in-transaction timeouts, transaction helper with isolation/lock options, migration runner as **single release job** (`drizzle.config.ts:12` out + `ops/migrate.sh`), separation of read-only/worker credentials where useful `engine_architecture.md:92-94`.

- [ ] **1.3** Codify SQL conventions `engine_implementation_plan.md:99-106` â€” UUIDv7 for new tables, UTC `timestamptz`, `created_at`/`updated_at`+ lifecycle timestamps, FK + check constraints, partial/covering indexes, no JSON blob for auth-critical fields â†’ `drizzle/*.sql` review checklist.

- [ ] **1.4** Expand RLS test helpers `src/common/infra/db/db.service.ts:54` (`withOrg`/`withBypass`) + isolation harness â€” direct analogue of `drizzle/0002_org_furniture.sql:68` `USING`/`WITH CHECK` `current_setting('app.current_tenant')` â†’ harness asserts tenant, owner, `BYPASSRLS` roles separately `engine_data_and_lifecycle.md:392-404`.

- [ ] **1.5** Structured error taxonomy `src/common/http/api-error.ts`, `src/common/http/all-exceptions.filter.ts:1` â€” stable `code`, public message, HTTP status, retryability, internal cause; never serializes DB rows directly `engine_implementation_plan.md:117`.

- [ ] **1.6** Time/clock/Randomness port for deterministic tests `engine_implementation_plan.md:109` (`common/infra/clock.ts`).

- [ ] **1.7** Metrics & dashboards skeleton â€” `src/common/observability/metrics.ts:1` extension (`outbox_lag`, `dead_letter`, `queue_depth`, `lock_wait`, `slow_query`, `upload_orphan`) + `ops/dashboards/*.json` `engine_implementation_plan.md:518-531`.

#### Exit gates â€” Phase 1

- [ ] Fresh DB: `pnpm migrate` + rollback/recovery procedure on a clean database passes in CI.
- [ ] `EXPLAIN` plans captured for list/lookup/auth/event/message queries.
- [ ] Connection-exhaustion & slow-query tests prove API fails predictably (pool saturation).
- [ ] RLS negative tests pass for every existing tenant-owned table (`withOrg(A)` cannot read `org_id=B`, cannot `INSERT` with mismatched `org_id`).
- [ ] No route serializes a DB row directly (response DTO + schema).

---

### Phase 2 â€” Identity, organization & authorization

*Objective: secure principals + org-scoped access before exposing product data `engine_implementation_plan.md:120-174`.*

#### 2A â€” Completed (preserve, do not regress)

These are DONE â€” gates already hold:

- [x] **`2.1` Users / external identities / memberships / API credentials** â€” `0001`/`0002`/`0009`/`0006` (`accounts`, `account_identities`, `org_memberships`, `api_keys` dual-write) `ownership-map.json:43-63`.
- [x] **`2.2` Authentication** â€” OIDC + PKCE, `oidc-provider`, JWKS, email codes, cookie session, API key L2 `src/common/auth/auth.guard.ts:1`, Argon2 `0001`.
- [x] **`2.3` Organization lifecycle** â€” projects/entitlements/groups/service accounts/invites with caps `0002`/`0009`/`0012`, staged deletion (`org_deletions`, `0012`/`0018`).
- [x] **`2.4` Guards** â€” `AuthGuard` L1/L2/L3 + `OrgRolesGuard`/`EntitlementGuard` + `PlatformStaffGuard` + `StepUp`.

#### 2B â€” Remaining hardening

- [ ] **2.5** Membership revocation immediacy â€” assert new requests are rejected per documented consistency policy `engine_implementation_plan.md:168`; revisit Redis deny-list TTL vs DB read for `satellites/revocations` feed `src/modules/satellites/revocation-log.service.ts`.

- [ ] **2.6** Cross-tenant authorization fuzz â€” every route Ã— two orgs Ã— multiple roles/principals `engine_implementation_plan.md:170` â†’ `tests/isolation/*.test.ts`.

- [ ] **2.7** SAML via IdP â€” confirm delegation (no Engine SAML implementation) `engine_architecture.md:146` â†’ `IdentityModule` SSO callback + key rotation tests.

- [ ] **2.8** `authorization_policies` table (optional, deferred if RBAC+RLS suffices) â€” immutable policy versions, decision records `engine_data_and_lifecycle.md:89-113` â†’ only if relationship complexity justifies `engine_architecture.md:568`.

#### Exit gates â€” Phase 2

- [ ] Revocation / disable / expiry rejected immediately for new requests.
- [ ] Cross-tenant fuzz passes for every existing route, worker, cache key, and object prefix.
- [ ] SSO callback failure / logout / key-rotation / account-linking tests pass.
- [ ] Support/impersonation is an explicit audited action (`staff_impersonations` `0011`) and cannot masquerade via customer token.

---

### Phase 3 â€” Organizations, assistants, policies & publication

*Objective: immutable organization configuration consumable by Studio without mutating live runs `engine_implementation_plan.md:176-221`.*

- [ ] **3.1** Design `assistants` domain â€” `assistants (id, organization_id, name, active_version_id FK, created_at/updated_at)` + `assistant_versions (id, assistant_id, version int, schema_version, model_policy jsonb, context_policy jsonb, tool_policy jsonb, guardrail_policy jsonb, status enum DRAFT->VALIDATING->VALID->PUBLISHED->RETIRED, published_at, rollback_of FK, hash)` `engine_data_and_lifecycle.md:89-113` â†’ `src/modules/assistants/*` (new module).

- [ ] **3.2** Publish invariants â€” draft mutation never touches published version; publish is atomic pointer change after validation; rollback points to prior immutable version `engine_data_and_lifecycle.md:103-111` â€” advisory lock (`SELECT pg_advisory_xact_lock`) patterned after `config-publish` `src/modules/config-publish/config-publish.service.ts:1`.

- [ ] **3.3** Validation layer â€” JSON Schema for public format, domain validation for model/tool refs + limits + dangerous combinations + policy completeness, capability-registry check against Model Gateway contract, redaction/secret scan before persist `engine_implementation_plan.md:207-213`.

- [ ] **3.4** Run pinning â€” every run stores `assistant_version_id` + `policy_snapshot_id/version` at acceptance (`engine_data_and_lifecycle.md:143-158`) â†’ tested in Phase 4.

- [ ] **3.5** Test-conversation endpoint â€” non-production budget, marks generated data as test data `engine_implementation_plan.md:213`.

- [ ] **3.6** Generalize config-publish as sibling, not replacement â€” keep `published_configs` for platform `policy_set`/`guardrail_profile`/`quota_profile`/`model_catalog`; introduce `assistants` for agent definitions. Do not conflate both into one table.

- [ ] **3.7** Rename legacy furniture â€” `src/modules/agent-studio` â†’ `src/modules/studio-furniture` (or `console/studio`) after `assistants` lands â€” `AgentStudioModule` `src/app.module.ts:13` currently at `studio_project_keys` only; rename prevents route/ownership ambiguity `engine_implementation_plan.md:213` product registration. Include import/codemod + `ownership-map.json` note; no behavior change.

#### Exit gates â€” Phase 3

- [ ] Concurrent `publish`/`update` cannot publish a partially written version (advisory-lock + transaction isolation test).
- [ ] An in-flight run remains pinned to its original assistant version after a new version is published.
- [ ] Invalid model/tool/knowledge/policy/quota refs rejected before `PUBLISHED`.
- [ ] Version export/import is deterministic and includes `schema_version`.
- [ ] `FORCE RLS` + application predicates on `assistants`/`assistant_versions`; cross-tenant access denied in isolation tests.

---

### Phase 4 â€” Conversations, messages, runs & canonical events

*Objective: durable conversation boundary + Engine run projection `engine_implementation_plan.md:223-266` + `engine_data_and_lifecycle.md:116-206`. This is the largest net-new domain â€” **0% today**.*

- [ ] **4.1** Create `conversations` table â€” `id uuidv7 pk`, `organization_id fk+RLS`, `channel_binding jsonb`, `participant_scope text`, `lifecycle/status enum active|archived|deleted`, `version int` (optimistic concurrency, `If-Match`/`expected_conversation_version`), `retention_class`, `created_at/updated_at` `engine_data_and_lifecycle.md:31-56, 116-129` â†’ `drizzle/00XX_conversations.sql`.

- [ ] **4.2** Create `conversation_participants` + `channel_bindings` where needed (multi-tenant channel identity) `engine_data_and_lifecycle.md:118-129`.

- [ ] **4.3** Create `messages` table â€” `id uuidv7`, `conversation_id fk`, `organization_id`, `sequence int` (monotonic per conversation, Engine-allocated), `role enum user|assistant|tool|system`, `content jsonb` (immutable parts), `artifact_refs jsonb`, `classification text`, `retention_class`, `created_at` `engine_data_and_lifecycle.md:130-138` â€” `sequence` via `SELECT MAX(sequence)+1 â€¦ FOR UPDATE` or DB sequence per conversation; never exposes DB sequence as API cursor without stable opaque mapping.

- [ ] **4.4** Create `runs` Engine projection â€” `id uuidv7`, `organization_id`, `conversation_id`, `input_message_id fk`, `assistant_version_id fk`, `policy_snapshot_id`, `state enum ACCEPTED|DISPATCHED|RUNNING|WAITING_APPROVAL|WAITING_INPUT|COMPLETED|FAILED|CANCELED|EXPIRED` + lease columns (`lease_owner`, `lease_epoch int`, `lease_expires_at`, `heartbeat_at`) + timestamps (`accepted_at/started_at/finished_at`, `terminal_reason`, `last_durable_event_cursor`) `engine_data_and_lifecycle.md:140-186` â†’ `drizzle/00XX_runs.sql`. RLS `organization_id`; unique partial index `one active user turn per conversation` `engine_implementation_plan.md:252`.

- [ ] **4.5** Create `run_events` (durable semantic events) â€” `event_id uuidv7 pk`, `run_id fk`, `organization_id`, `aggregate_type/version` + `event_type` + `schema_version` + `engine_sequence bigint` (authoritative, `SERIAL` per aggregate or monotonic `BIGSERIAL` with `run_id` ordering), `causation_id`, `correlation_id`, `producer_identity`, `payload jsonb` or `artifact_id FK`, `created_at` `engine_data_and_lifecycle.md:188-217` â€” `run_id+engine_sequence` unique; per-aggregate ordering defined, no global ordering promise.

- [ ] **4.6** Create `summaries` + `conversation_summaries` (optional) â€” `conversation_id`, `summary text/artifact_ref`, `source_range (from_seq,to_seq)`, `version`, `assistant_version_id` `engine_data_and_lifecycle.md:118-129` â€” supports long-conversation reconstruction without copying provider state `engine_architecture.md:209-235`.

- [ ] **4.7** Implement **start-message transaction** â€” `POST /api/v1/conversations/{conversation_id}/messages` â†’ authorize conversation+assistant â†’ verify expected version / active-turn policy â†’ insert user message â†’ insert `runs ACCEPTED` â†’ insert `outbox RunCreated` (generic outbox, Â§6) â†’ commit `engine_implementation_plan.md:238-246` â€” one PostgreSQL transaction `engine_data_and_lifecycle.md:431` row 1. Return `message_id`/`run_id`/`event_cursor` + idempotency semantics.

- [ ] **4.8** Implement **final-message atomic commit** â€” `CommitRunResult` (Phase 5 hook) inserts assistant message + transitions `run->COMPLETED` + `run_events` terminal event in **one** transaction `engine_data_and_lifecycle.md:436` row 8 â†’ `src/modules/conversations/services/runs.service.ts` pattern.

- [ ] **4.9** Implement conversation-level concurrency â€” uniqueness/lease invariant, not in-memory mutex `engine_implementation_plan.md:251-253` â€” documented one-turn policy; parallel-turn branches require explicit turn identifiers.

- [ ] **4.10** Implement event cursors & pagination â€” `GET /api/v1/conversations/{id}/messages?cursor&limit` + `GET /api/v1/runs/{id}/events?after_sequence&limit` â†’ cursor pagination, `next_cursor`, `ETag`/`version`, SSE via `GET /api/v1/runs/{id}/events:stream` using `Last-Event-ID` replay `engine_architecture.md:323-355` `engine_implementation_plan.md:606-635`.

- [ ] **4.11** Enforce bounded payloads + claim-check â€” large parts + large tool results use `ArtifactRef` (`artifact_id`, `organization_id`, `purpose` enum, `sha256`, `byte_length`, `encryption_key_id`, `expires_at`, `retention_class`) `engine_data_and_lifecycle.md:271-289` â€” PG row never stores unbounded content `engine_architecture.md:584` row 10.

- [ ] **4.12** Wire `EngineEvents` fan-out â€” `EventBus` post-commit projection â†’ RLS-aware read path â†’ audit + metering hooks â†’ remove direct `EventBus` side effects that race commit.

#### Exit gates â€” Phase 4

- [ ] Duplicate `POST /messages` with same idempotency key creates one user message + one run.
- [ ] Stale `expected_conversation_version` returns typed conflict (no message created).
- [ ] Concurrent turn attempts obey documented one-turn policy (unique constraint + lease test).
- [ ] Final assistant message + `run COMPLETED` commit atomically; inconsistency impossible on crash after commit.
- [ ] Replayed event delivery cannot duplicate user-visible messages (inbox + `run_events` `(run_id,event_id)` dedup).
- [ ] Cursor pagination stable and reconnectable (after `Event-ID` replay returns identical page).
- [ ] RLS + app predicate negative tests pass for `conversations`/`messages`/`runs`/`run_events`; vector/search not yet introduced but `organization_id` present.

---

### Phase 5 â€” Neryva MCP authority & Agent Studio integration

*Objective: Engine half of `neryva.mcp.v1` `engine_architecture.md:357-371` — **MCP contract is DONE in `../products/neryva_mcp/neryva-mcp-contract`** (sibling of `engine/`); this phase consumes it.*

**Precondition â€” contract as dependency:**

- `../products/neryva_mcp/neryva-mcp-contract/proto/neryva/mcp/*` (`buf.yaml`, `buf.gen.yaml`, generated `gen/ts`) + `@bufbuild/protobuf` + `@connectrpc/connect` `engine_architecture.md:137-138` â†’ published as internal package `@neryva/mcp-contracts`.
- Engine imports generated types only â€” no hand-copied wire objects `engine_implementation_plan.md:605`.

#### Tasks â€” authority surface

- [ ] **5.1** Host ConnectRPC authority services â€” `@connectrpc/connect-fastify` (or `connect-node`) adapter into NestJS/Fastify `src/transport/mcp/*` â†’ `RunAuthorityService` 11 RPCs: `AcquireOrRenewRunLease` / `GetAuthorizedRunContext` / `AppendRunEvents` / `CreateApprovalRequest` / `SubmitMemoryProposal` / `AuthorizeToolCall` / `RecordToolOutcome` / `SaveCheckpointRef` / `CommitRunResult` / `FailRun` / `ReleaseRunLease` `docs/architecture/neryva_mcp/neryva_mcp_implementation_plan.md:352-366` + `RunObservationService` (server-streaming `WatchRunEvents`) + `RuntimeControlService` client (Engine calls `StartRun`/`CancelRun`/`DeliverRunInput` on Studio).

- [ ] **5.2** Authenticate Studio workload identity â€” mTLS / SPIFFE SVID / equivalent per `engine_architecture.md:180-190` â€” new `agent-studio-runtime` service identity `src/common/auth/principal.ts:1` already has `L3Principal` shape; add dedicated issuer/rotation.

- [ ] **5.3** Issue + validate run-scoped capability tokens â€” `aud=neryva-agent-studio`, `organization_id`, `conversation_id`, `run_id`, assistant/policy versions, allowed operations set, `capability_id`/`nonce`, `iat`/`exp`, `kid`, optional `lease_epoch` â†’ `neryva_mcp_implementation_plan.md:682-718`. Every MCP server interceptor validates transport security â†’ request-size limits â†’ authentication â†’ trace extraction â†’ request validation (Protovalidate) â†’ scope/capability â†’ idempotency/replay â†’ authorization â†’ handler â†’ audit/metrics.

- [ ] **5.4** Implement `AcquireOrRenewRunLease` + `ReleaseRunLease` â€” `run_leases (run_id pk, lease_owner, lease_epoch, lease_expires_at, heartbeat_at)` â€” CAS increment on renew; stale epoch `ABORTED` `neryva_mcp_implementation_plan.md:448`.

- [ ] **5.5** Implement `GetAuthorizedRunContext` manifest (bounded; filters in query, not after) â€” `assistant_version` + `policy_version` + `bounded recent messages` + `summary` + `approved memories` + `authorized knowledge refs` + `filtered tool descriptors` + budgets + `ArtifactRef`s `neryva_mcp_implementation_plan.md:556-582`.

- [ ] **5.6** Implement idempotent `AppendRunEvents` â€” bounded batch, per-event `RunEvent { event_id, run_id, step_id, type, schema_version, producer_identity, producer_sequence (diagnostic only), expected_version, timestamp, redaction, body/artifact_ref }` â†’ unique `(run_id,event_id)`, authoritative `engine_sequence`, `terminal -> reject` `neryva_mcp_implementation_plan.md:520-549`.

- [ ] **5.7** Implement `CreateApprovalRequest` + `DeliverRunInput` outbox path â†’ Temporal Signal by default (Update only when sync workflow-level validation needed) `neryva_mcp_implementation_plan.md:640-653`.

- [ ] **5.8** Implement checkpoint claim-check â€” `checkpoints (run_id fk, checkpoint_version, artifact_id fk, digest, producer, created_at)` + size/retention limits `neryva_mcp_implementation_plan.md:597-605`.

- [ ] **5.9** Implement `SubmitMemoryProposal` â€” candidate stored in `memory_proposals` table, not yet durable memory until Engine policy/approval `neryva_mcp_implementation_plan.md:1169`.

- [ ] **5.10** Implement `AuthorizeToolCall` + `RecordToolOutcome` â€” scoped tool capability (bound to `run_id`/`step_id`/`tool_call_id`/`version`/`argument digest`) + durable `tool_effects` dedup `neryva_mcp_implementation_plan.md:585-596`.

- [ ] **5.11** Implement terminal atomicity â€” `CommitRunResult`: validates capability + lease epoch â†’ inserts final assistant `messages` row + transitions `runs->SUCCEEDED` + emits durable `run_events` + usage ledger entry in **one** transaction â†’ idempotent retry returns same `message_id` `engine_implementation_plan.md:261-265`; `FailRun` analogue.

- [ ] **5.12** Artifact authorization facade â€” 7 checks: `artifact_id`+`purpose`, run/org scope, short expiry, checksum, byte-range, content-type allowlist, encryption key policy, deletion status `neryva_mcp_implementation_plan.md:569-577`; `sha256` exactly 32 bytes validated at schema boundary; ref is opaque capability, not bearer URL.

#### Prohibited

- [ ] No Agent Studio DB credentials â€” `engine_architecture.md:570` row 2.
- [ ] No unbounded payload in RPC/workflow args â€” claim-check instead `engine_architecture.md:584`.
- [ ] No producer-local sequence as canonical â€” Engine sequence is authority `engine_implementation_plan.md:534`.

#### Failure cases to implement first `engine_implementation_plan.md:296-306`

- [ ] Studio crashes after tool side effect but before `RecordToolOutcome` ack.
- [ ] MCP response lost after `CommitRunResult` commit â€” retry idempotent.
- [ ] Duplicate `AppendRunEvents` same idempotency key but different payload â†’ conflict.
- [ ] Capability expires mid-run.
- [ ] Assistant version unpublished mid-run (run stays pinned).
- [ ] Membership/policy revoked mid-run.
- [ ] Engine accepted message but dispatcher down.
- [ ] Events after `CANCELED`/terminal.

#### Exit gates â€” Phase 5

- [ ] Neryva MCP conformance suite (generated from `../products/neryva_mcp/conformance/*`) passes Engine + fake Studio adapter.
- [ ] Scope-confusion tests cannot widen tenant/conversation/actor/assistant version.
- [ ] `CommitRunResult` retry returns same committed `message_id` (no duplicate assistant message).
- [ ] Capability rotation/revocation tests pass.
- [ ] No MCP handler performs SQL outside `src/modules/*` application modules.
- [ ] Engine sequence is authoritative for `WatchRunEvents` replay.

---

### Phase 6 â€” Outbox, inbox, broker & async workers

*Objective: every async boundary durable, observable, replay-safe `engine_architecture.md:373-399`.*

> Until Phase 6, the only async durable path is the single outbox row created in Phase 4 start-message transaction. Phase 6 generalizes that primitive and retires bare `EventBus` + `BullMQ` best-effort delivery for business state.

- [ ] **6.1** Create `outbox_events` â€” `event_id pk`, `aggregate_type/id`, `organization_id`, `event_type/version`, `payload jsonb` or `claim-check artifact_id`, `partition_key`, `status enum PENDING|CLAIMED|PUBLISHED|RETRY_WAIT|DEAD_LETTER`, `attempt_count`, `next_attempt_at`, `trace/correlation_ids`, `created_at` `engine_data_and_lifecycle.md:219-255` â†’ `drizzle/00XX_outbox.sql`. Insert in **same transaction** as canonical change `engine_architecture.md:584` row 7.

- [ ] **6.2** Create `inbox_events` â€” `consumer_name`, `event_id`, `first/last_received_at`, `status`, `result_ref` â€” unique `(consumer_name,event_id)` `engine_data_and_lifecycle.md:233-240`.

- [ ] **6.3** Implement `engine-dispatch` role â€” claim with lease (`SELECT ... FOR UPDATE SKIP LOCKED`), bounded batch, publish with `event_id` key, exp backoff + jitter, dead-letter after threshold, operator-authorized replay `engine_implementation_plan.md:343-345` â†’ `src/workers/outbox-dispatcher.ts` (or `src/common/events/dispatcher.ts`). May embed in `engine-worker` initial deploy but keep role explicit `engine_architecture.md:121-126`.

- [ ] **6.4** Implement consumer contract â€” validate `schema_version`, enforce `organization_id` scope, **deduplicate via inbox before side effect**, write result + next outbox atomically, record `retryable` failure class `engine_implementation_plan.md:347-351`.

- [ ] **6.5** Choose durable fan-out â€” start with PostgreSQL polling; add NATS JetStream when replay/consumer isolation/backpressure requires it `engine_architecture.md:143-144` â€” stable IDs + explicit ordering keys; never assume exactly-once; if Debezium CDC later needed, preserve same outbox schema `engine_architecture.md:396-398`.

- [ ] **6.6** Worker families â€” `agent-run-projection` / `notifications` / `webhook delivery` / `knowledge ingestion` / `usage/billing reconciliation` / `export` / `retention+deletion` / `orphan cleanup` `engine_implementation_plan.md:355-364` â†’ `src/workers/*` with bounded concurrency + per-tenant fairness `engine_architecture.md:496`.

- [ ] **6.7** Harden idempotency record â€” **move from Redis-only to DB+Redis tiered** â€” `idempotency_records (scope principal+organization, endpoint_family, idempotency_key, request_hash, status IN_PROGRESS|SUCCEEDED|FAILED_RETRYABLE|FAILED_FINAL, resource_ref, response_ref, created_at/expires_at)` unique `(scope,endpoint_family,idempotency_key)` `engine_data_and_lifecycle.md:241-261` â€” Redis holds ephemeral lease, DB is authority. `src/common/http/idempotency.ts:54` (`idem:principal:key`) becomes cache layer. Uniqueness scope: `organization_id + principal_id + endpoint_family + idempotency_key` `engine_architecture.md:243-247`.

- [ ] **6.8** Retire bare `EventBus` as business delivery â€” `src/common/events/event-bus.ts:1` stays as in-process **notification** bus for cache-invalidation/projection hints; every business fact gains an outbox row. Document seam.

#### Exit gates â€” Phase 6

- [ ] Crash/restart/redelivery tests prove handlers idempotent (`kill -9` API/worker after each durable boundary).
- [ ] `outbox_age`, `retry_count`, `dead_letter_count` metrics + alerts fire in `ops/dashboards`.
- [ ] Replayed event cannot cross tenant or double-bill (inbox dedup + `reversal_ref` tests).
- [ ] Per-aggregate ordering guarantees tested (per `run_id`/`conversation_id` key).
- [ ] Backpressure isolates one tenant/consumer starvation (`EXPLAIN` + load test).
- [ ] `EventBus.emit` post-commit best-effort semantics no longer relied on for canonical state (`usage`, `audit`, `run`).

---

### Phase 7 â€” Files, uploads, knowledge & claim-check storage

*Objective: secure large-payload handling + rebuildable pipeline `engine_architecture.md:425-447` + `engine_data_and_lifecycle.md:263-299`.*

- [ ] **7.1** Create `artifacts` table â€” `id`, `organization_id`, `owner_resource (purpose enum SOURCE_DOCUMENT|EXPORT|CHECKPOINT|TOOL_RESULT|TRANSCRIPT|COVER)`, `object_key` (opaque, tenant-bound prefix `org/{org_id}/...`), `content_type_detected`, `content_length`, `sha256`, `encryption_key_ref`, `scan_status`, `retention_class`, `expires_at`, `created_at` `engine_data_and_lifecycle.md:271-289` â†’ claim-check contract 11 fields `engine_architecture.md:399-414`. Purpose is allowlisted enum â€” ref cannot be recast `engine_data_and_lifecycle.md:290`.

- [ ] **7.2** Create `upload_sessions` state machine â€” `id`, `organization_id`, `purpose`, `artifact_id fk`, `size_bounds`, `media_type allowlist`, `expires_at`, `state enum CREATED->UPLOADING->UPLOADED->SCANNING->EXTRACTING->INDEXING->READY / QUARANTINED/FAILED` `engine_architecture.md:427-443` â€” authorize then `StorageService.presignUpload` `src/common/infra/storage/storage.service.ts:43` with exact key + method + length + checksum + short TTL.

- [ ] **7.3** Harden `StorageService` â€” tenant-bound key prefix enforcement, multipart support (`abortIncompleteMultipartUpload`), content-type/chunk checksum verification on completion, malware scan stage `engine_architecture.md:426-447`, fail-closed when `S3_*` unconfigured.

- [ ] **7.4** Create `documents -> document_versions -> chunks -> embeddings` â€” `documents (id, organization_id, source_artifact_id, state)`, `document_versions (id, document_id, version, sha256, parser_version)`, `chunks (id, document_version_id, source_range, citation_span, chunk_hash)`, `embeddings (id, chunk_id, embedding vector<pgvector>, model)`, plus `retrieval_acl` `engine_data_and_lifecycle.md:263-291` â€” chunks always reference a versioned source + range.

- [ ] **7.5** Enable `pgvector` + PostgreSQL full-text search `engine_architecture.md:535-540` â€” `CREATE EXTENSION vector`; hybrid retrieval path. Move to dedicated vector service only after benchmark `engine_implementation_plan.md:561`.

- [ ] **7.6** Implement ingestion pipeline (sandboxed) â€” `SCANNING` (ClamAV/managed scan + quarantine) â†’ `EXTRACTING` (bounded byte/page/decompression/nesting/time/output limits, no API process parsing `engine_architecture.md:444-446`) â†’ `INDEXING` (versioned chunks+embeddings) â†’ `READY` only then retrievable; resume-safe at each stage.

- [ ] **7.7** Implement retrieval policy â€” tenant + ACL filter **before** scoring `engine_data_and_lifecycle.md:396` â†’ `WHERE organization_id=$1 AND acl ... <-> embedding` â€” post-ranking filter is not authorization; filter predicates in query. Test deleted/quarantined/expired/unready never returned.

- [ ] **7.8** Implement `memory_items` adjacent (Phase 7 or 4, decide here) â€” `id`, `organization_id`, `scope_type+scope_id`, `content/artifact_ref`, `source_message/document_ref`, `provenance`, `confidence`, `approval_status`, `visibility`, `expires_at`, `embedding_ref`, `deleted_at` `engine_data_and_lifecycle.md:303-323` â€” retrieval authorized by scope before returned to Studio; proposal (`SubmitMemoryProposal`) validated against policy/approval.

- [ ] **7.9** Wire retention â€” every artifact carries `retention_class`; object lifecycle + `purge_tasks` (Phase 9) reconciles derived stores.

#### Exit gates â€” Phase 7

- [ ] Oversize / wrong MIME / checksum mismatch / malicious archive / parser timeout tests pass.
- [ ] Signed URL cannot read/write another tenant's prefix (object key + STS test).
- [ ] Ingestion resumes after each stage crash without duplicate `chunks` (idempotent by `document_version` uniqueness).
- [ ] Search never returns non-`READY` / deleted / quarantined / unauthorized doc.
- [ ] Rebuild-from-source test on clean DB returns equivalent chunk metadata.
- [ ] No large prompt/document in `run_events` / NATS payload / Temporal args / PG row â€” `ArtifactRef` used.

---

### Phase 8 â€” Billing, quotas, entitlements & reconciliation

*Objective: explainable, idempotent, outage-independent `engine_architecture.md:401-425` + `engine_data_and_lifecycle.md:324-353`.*

#### 8A â€” Completed (preserve)

- [x] **`8.1` Spend-ingest with catalog trust fix** â€” `billing.spend_events(source,event_id)UQ` `0004`, `billing.price_catalog` `0011`, `SpendIngestService BILLING_COST_VALIDATION derive|enforce|trust` (`derive` default, `enforce` rejects>10% deviation) `src/modules/billing/services/spend-ingest.service.ts` + `env.ts:71`.
- [x] **`8.2` Invoices + credit/budget/adjustments/lines** â€” `billing.billing_invoices` + `billing_credits`/`billing_budgets`/`billing_invoice_lines`/`billing_adjustments` `0014` + `InvoicesService`/`PlanChangeService`.
- [x] **`8.3` Stripe rail** â€” `StripeService` + Checkout + webhook HMAC `POST /webhooks/stripe` `src/modules/billing/stripe.service.ts:1`.
- [x] **`8.4` Anomaly/B5 & budget thresholds** â€” `AnomalyService` `BILLING_ANOMALY_CRON` + `TrialExpiryService` `BILLING_TRIAL_SWEEP_CRON` + `BillingWorker` `env.ts:50-54`.

#### 8B â€” Remaining

- [ ] **8.5** Introduce immutable `usage_ledger` append-only â€” `usage_ledger_entries (id, organization_id, usage_event_id unique, source_type/id, run_id/message_id, usage_kind, unit, quantity, provider/model metadata, estimated_cost, settled_cost, currency, idempotency_key unique, reversal_ref FK, reconciliation_state, created_at)` `engine_data_and_lifecycle.md:326-342`. Harvest from `billing.spend_events` initially; corrections via compensating entries (never mutate history) `engine_architecture.md:418-424`.

- [ ] **8.6** Harden quota enforcement â€” per-dimension `requests`/`model tokens`/`cost`/`storage bytes`/`ingest work`/`tool ops`/`seats`/`rate` â€” atomic `RESERVED->COMMITTED->RELEASED` where reservation needed, otherwise append-only accounting `engine_implementation_plan.md:435-446`.

- [ ] **8.7** Implement provider reconciliation job â€” compares provider records vs `usage_ledger` vs entitlements hourly/daily, inbox-deduped, writes compensating entries + dead-letters discrepancy `engine_implementation_plan.md:448` â€” `engine-jobs` role.

- [ ] **8.8** Harden webhook inbox â€” `received -> signature_validated -> DEDUPLICATED -> PROCESSED -> RECONCILIATION_REQUIRED` with `provider_event_id`, signature result, hash, reconciliation status `engine_data_and_lifecycle.md:346-356` â†’ separate from outbound `webhook_deliveries`.

- [ ] **8.9** Deterministic quota during provider outage â€” entitlement snapshot governs rejection, not live billing provider `engine_architecture.md:422-424` â†’ outage injection test.

- [ ] **8.10** Explainability trace â€” run â†’ ledger â†’ meter/invoice `engine_architecture.md:418-425` â†’ `GET /console/usage/:orgId/ledgers` + `GET /console/billing/invoices/:id` links.

#### Exit gates â€” Phase 8

- [ ] Duplicate usage event (same `(source,event_id)` / same `usage_event_id`) is ignored.
- [ ] Payment-provider webhook cannot grant entitlement without validated `provider_reconciliation` reconciliation.
- [ ] Quota decisions deterministic during billing provider outage.
- [ ] Discrepancies detectable and correctable via compensating ledger entries, never history rewrite.
- [ ] Cost/usage explainable `run_id` â†’ `usage_ledger_entries` â†’ external meter/invoice.

---

### Phase 9 â€” Audit, retention, export, legal hold & deletion

*Objective: lifecycle as a product capability `engine_architecture.md:462-491` + `engine_data_and_lifecycle.md:359-436`.*

#### 9A â€” Completed (preserve)

- [x] **`9.1` Hash-chained audit** â€” `audit_events` chain `src/common/audit/audit.service.ts:12` (`canonicalJson` + `canonicalUtcIso` + `pg_advisory_xact_lock('neryva_audit_chain')`) byte-identical to Python `0001` lineage.
- [x] **`9.2` Staged deletions** â€” `org_deletions (status requested|cancelled|purged)` `0012` + `OrgPurgeWorker` (`ORG_DELETION_GRACE_DAYS` `env.ts:73`) + `accounts.deleted_at` `0018` + `AccountPurgeWorker` (`ACCOUNT_DELETION_GRACE_DAYS`).

#### 9B â€” Remaining

- [ ] **9.3** Introduce `retention_policies (id, organization_id, scope data_type, retention_class, keep_until_rule, created_at)` + `retention_classes` enum `engine_data_and_lifecycle.md:26-56` per org/resource/type.

- [ ] **9.4** Introduce `legal_holds (id, organization_id, scope_type/id, hold_reason, placed_by, placed_at, expires_at nullable, status active|released)` â€” `legal_hold` blocks eligible `purge` while allowing unrelated retention work `engine_implementation_plan.md:492` `engine_data_and_lifecycle.md:383-386`.

- [ ] **9.5** Introduce `export_requests (id, organization_id, actor_id, scope, manifest jsonb, encryption_key_ref, state pending|ready|expired, expires_at, download_count, audit_ids)` â€” authorizes requester, snapshots authorized records + permitted `ArtifactRef`s from consistent point-in-time, encrypted archive in private storage, one-time signed download, expiry, audit `engine_implementation_plan.md:469-475`.

- [ ] **9.6** Introduce `purge_tasks (id, scope_type/id, organization_id, state pending|in_progress|done|failed, step, last_error, created_at)` + worker idempotency + exception reporting `engine_data_and_lifecycle.md:372-386` â€” deletion order enforced:
  `authorize -> check hold/retention -> mark product/search unavailable -> emit derived-store deletion via outbox -> purge caches+indexes -> purge objects -> purge/redact PG content per policy -> tombstone + completion evidence` `engine_data_and_lifecycle.md:374-385`.

- [ ] **9.7** Separate `audit_log` vs `data_access_records` â€” sensitive reads / exports / support access / policy changes as distinct stream `engine_architecture.md:478-489` `engine_data_and_lifecycle.md:489-490`.

- [ ] **9.8** Tombstones â€” stale IDs known + rejected after purge; needed for `CommitRunResult`/`GetAuthorizedRunContext` to fail-closed on deleted conversation.

- [ ] **9.9** Backup/retention alignment â€” document how backup expiry interacts with deletion guarantee `engine_data_and_lifecycle.md:385-387`.

#### Exit gates â€” Phase 9

- [ ] `legal_hold` blocks purge for covered scope while unrelated retention still runs.
- [ ] Deletion removes data from API, `run_events`, cache, objects, derived indexes per policy; exceptions reported, not silently completed.
- [ ] Export never includes another tenant; archive expires safely.
- [ ] `audit_events` survive ordinary row deletion and support operator review; `verifyChain` green for bounded window.
- [ ] Deletion/recovery drill produces an evidence report on isolated environment.

---

### Phase 10 â€” Enterprise operations & production hardening

*Objective: `engine_implementation_plan.md:500-531` â€” security, reliability, DR.*

#### 10A â€” Security

- [ ] **10.1** Map OWASP ASVS 5.0.0 controls to requirements/code/tests `engine_architecture.md:462-463`.

- [ ] **10.2** Supply-chain gates â€” SAST + dependency/license scanning + secret scanning + SBOM generation + container scanning + DAST `engine_architecture.md:460-463`.

- [ ] **10.3** Credential rotation â€” DB/IdP/broker/object-store/provider/service identities without downtime `engine_implementation_plan.md:506-508`.

- [ ] **10.4** Red-team â€” tenant isolation, prompt/tool boundary, signed URLs, inbound webhooks, support access, deletion paths `engine_implementation_plan.md:508`.

#### 10B â€” Reliability

- [ ] **10.5** SLOs from measured traces â€” API availability + p95/p99 by route family, `message accepted -> first run event`, `run completion latency`, `outbox age`, `inbox lag`, DB pool/lock/replica metrics, quota rejection rate `engine_architecture.md:516-531`.

- [ ] **10.6** Dashboards â€” API, `outbox_lag`/`dead_letter`, worker pool, object-store orphan rate, provider failure, audit write failure `engine_implementation_plan.md:521-529`.

- [ ] **10.7** Dependency degradation drills â€” cache down, broker down, object storage slow, provider timeout, IdP key rotation, billing outage `engine_implementation_plan.md:514-515`.

- [ ] **10.8** Graceful shutdown + rolling deploy with active SSE streams + worker lease (`SIGTERM` drain â†’ flush OTel `shutdownTracing()` `src/tracing.ts:60`).

#### 10C â€” Disaster recovery

- [ ] **10.9** Managed PostgreSQL HA + continuous archiving + PITR `engine_architecture.md:495-515`.

- [ ] **10.10** Object versioning/lifecycle + cross-region strategy per tenant tier `engine_architecture.md:272-283`.

- [ ] **10.11** Rebuildable search/index â€” reindex from canonical `documents`/`chunks` `engine_implementation_plan.md:522-523`.

- [ ] **10.12** Restore rehearsal on schedule with measured RPO/RTO `engine_implementation_plan.md:526-531` â€” runs on clean environment covering PG PITR, object restore+reference reconciliation, outbox replay, Engine workflow resume, cursor reconnect, provider/billing reconciliation.

#### Exit gates â€” Phase 10

- [ ] Production release has signed `security + migration + restore + rollback` checklist `engine_implementation_plan.md:527-531`.
- [ ] Chaos covers API replicas, worker crashes, broker redelivery, DB failover, provider failure.
- [ ] DR rehearsal meets declared RPO/RTO or produces explicit remediation plan.
- [ ] On-call can identify/pause/replay/quarantine a failing tenant/job without direct prod SQL `engine_implementation_plan.md:531`.

---

### Phase 11 â€” Optional scale & isolation extensions

*Only from measurement or contract `engine_implementation_plan.md:533-544` `engine_architecture.md:272-283`.*

Do not enter without evidence â€” each extension must preserve the 12 non-weakening decisions `engine_architecture.md:570-584`.

- [ ] **11.1** High-volume fan-out â€” move outbox polling â†’ Debezium/Kafka (preserve `outbox_events` schema + `payload_version`) when `outbox_age` proves polling insufficient.

- [ ] **11.2** Relationship authorization â€” OpenFGA externalized ReBAC `engine_architecture.md:568` with explicit consistency/revocation design; Engine fallback for high-risk actions.

- [ ] **11.3** Isolated tenant cells â€” per-tenant DB/cluster tier `engine_architecture.md:273-283`; placement resolved before data access via same port/authz, no business-model branch.

- [ ] **11.4** Dedicated search/vector service â€” after measured `pgvector` limits (latency/cost/ops) `engine_architecture.md:565-567`.

- [ ] **11.5** Sandbox isolation â€” dedicated service for customer-authored code / high-risk tools `engine_architecture.md:544` `engine_implementation_plan.md:541`.

- [ ] **11.6** Module-as-service split â€” only with written ownership/data/failure/migration plan `engine_implementation_plan.md:542`.

---

## 6. Cross-phase invariants & hardened paths (must stay green from Phase 1)

These are the non-weakening 12 from `engine_architecture.md:570-584`, mirrored as `engine_data_and_lifecycle.md:430-445` consistency summary:

| # | Invariant | Required mechanism | Test family |
|---|---|---|---|
| 1 | Engine is system of record for customer-facing business data | `conversations`/`messages`/`runs`/`usage_ledger`/`audit` all Engine PG | correctness |
| 2 | Agent Studio has no direct DB credentials | Generated Neryva MCP clients only | security |
| 3 | Every tenant-owned query + object access carries `organization_id` | RLS + app predicates + tenant-bound object key prefix | isolation |
| 4 | Every externally retried command has idempotency story | `idempotency_records` (DB) + domain uniqueness + tool keys | property |
| 5 | Every published assistant version is immutable | `assistant_versions` hash + advisory-lock publish | unit |
| 6 | Every side effect has durable outcome or reconciliation path | outbox + inbox + `tool_effects` + provider reconciliation | failure |
| 7 | Outbox in same transaction as announced fact | `INSERT outbox_events` in same TX | integration |
| 8 | Durable semantic events separate from ephemeral token streaming | `run_events` vs Redis coalesced deltas | load |
| 9 | Audit/billing is append-oriented, never rewritten | Hash chain + compensating ledger | integration |
| 10 | Large/sensitive payloads use claim-check refs | `ArtifactRef` with 7 facade checks | isolation |
| 11 | Deletion/retention/export/legal-hold are first-class workflows | `purge_tasks` + holds + evidence report | chaos |
| 12 | Frameworks are replaceable adapters, not business truth | Drizzle/Fastify/Nest/OVEL remain thin | architecture |

---

## 7. Deletion & rename register

| Target | Action | When | Notes |
|---|---|---|---|
| Legacy `src/modules/agent-studio` furniture | **Rename** `src/modules/agent-studio` â†’ `src/modules/studio-furniture` (or `src/modules/console/studio`) and update `AppModule` `ModuleFlags.agentStudio` mapping | Phase 3 (gate of `assistants` domain) | No behavior change; prevents routing/ownership confusion with new Studio runtime. Keep `studio_project_keys` table; additive columns already require Python Alembic 0017. |
| Hard delete of legacy Agent Studio execution surfaces | **Delete** any remaining in-`engine/` execution runtime, broker fan-out shims, or sat-embedded agent loops that duplicate `runs`/`run_events` â€” replace with MCP authority | Phase 4â€“5 | Confirm no `../products/neryva_mcp` attachment remains `engine/`-internal after 5.6. |
| `ownership-map.json` | **Add** entries for every new table to `engine-ts` owner; never list new tables as `python` | Same PR as migration | Enforced by `validateFlagMatrix` + migration self-check at kernel boot. |
| `api_keys` direct mutation | **Remove** dual-write seams only at handover A-1 per `ownership-map.json:63-65` note; until then keep L2 verify + `KeysModule` dual path | Post-Phase 2 | Do not early-retire Python-owned `api_keys` DDL. |

---

## 8. Contract checklists

### 8.1 Public API checklist â€” every endpoint must specify `engine_implementation_plan.md:606-621`

`auth requirement` Â· `organization/resource scope` Â· `request/response JSON Schema` Â· `max body/field sizes` Â· `idempotency` (scope + hash + expiry) Â· `concurrency` (`If-Match`/`version`) Â· `pagination` (cursor) Â· `error codes + retryability` Â· `audit event` Â· `rate-limit class` Â· `data classification + retention impact` Â· `OTel span attributes` (low-cardinality).

### 8.2 Event checklist â€” every event must specify `engine_implementation_plan.md:623-635`

`stable event_id` Â· `event_type` + `schema_version` Â· `source + aggregate (run_id/conversation_id)` Â· `organization_id scope` Â· `ordering key` Â· `causation/correlation ids` Â· `payload size / claim-check rule` Â· `consumer idempotency key` Â· `retention + replay policy` Â· `authorization implications`.

### 8.3 Migration checklist â€” every migration must satisfy `engine_data_and_lifecycle.md:406-420`

`ordered + reviewed + immutable after merge + single release job` Â· `expand/contract: add nullable -> deploy writers -> bounded backfill -> verify counts/checksums -> switch reads -> remove` Â· `no long lock` Â· `rollback or forward-fix` Â· `resumable data migration steps` Â· `destructive drop only after retention/deletion evidence`.

---

## 9. Test strategy by family `engine_implementation_plan.md:637-677`

| Family | Focus | Where |
|---|---|---|
| **Unit** | State transitions (assistants, runs, approvals, ledger), validators, entitlement math, policy eval, idempotency decisions, cursor pagination, retention eligibility | `tests/unit/*` |
| **Integration** | Real PostgreSQL + MinIO + Redis/Valkey + Temporal (+ NATS when added): migrations, RLS, `SELECT â€¦ FOR UPDATE`, signed URLs, TX rollback, timeouts | `tests/integration/*` |
| **Contract** | OpenAPI schema compatibility + response filtering; Neryva MCP generated client/server interop; provider/billing/webhook adapter fixtures; event schema `unknown-field` tolerance | `tests/contract/*` |
| **Isolation** | Two orgs Ã— multiple roles â€” every route/worker/consumer/cache key/object prefix/retrieval query/export/support op/deletion â†’ must deny cross-tenant | `tests/isolation/*` |
| **Property / concurrency** | Duplicate/reordered delivery, lost-response retry, concurrent publish/message submission/cancellation/completion/deletion, lease fencing, ledger compensation, cursor gap/duplicate replay | `tests/property/*` |
| **Failure / chaos** | Kill API/worker after each durable boundary, drop remote responses, delay/reorder broker messages, degrade object storage/provider/billing/cache/IdP, fail DB during commit/rollback, restart during deploy | `tests/chaos/*` |
| **Performance** | Tenant-skewed workloads, long-conversation reads, event stream reconnects, upload completion, ingestion throughput, authz checks, outbox lag, quota checks, reconciliation | `tests/load/*` |

---

## 10. Operational runbooks required before production `engine_implementation_plan.md:679-696`

`database failover + PITR` Â· `migration rollback/forward-fix` Â· `outbox lag + dead-letter replay` Â· `stuck/expired MCP capability + run projection` Â· `worker crash + lease recovery` Â· `provider outage + model failover` Â· `billing webhook outage + reconciliation` Â· `object orphan cleanup` Â· `malware quarantine + false-positive review` Â· `cross-tenant incident response` Â· `credential/key rotation` Â· `data export + deletion request` Â· `legal hold place/remove` Â· `regional isolation + failover` Â· `security incident evidence preservation` â†’ `ops/runbooks/*.md` + dashboards/alerts in `ops/`.

---

## 11. Release gates â€” pipeline must block on `engine_implementation_plan.md:698-709`

1. `typecheck` + `lint` + `formatting` + unit tests.
2. Migration `apply` on clean DB and `upgrade from previous release`.
3. Integration + RLS + contract + idempotency tests.
4. OpenAPI + Neryva MCP compatibility (`buf breaking` vs baseline) checks.
5. Dependency / license / security scans + SBOM.
6. Load smoke test + DB `EXPLAIN` plan regression.
7. Restore/replay evidence for the release train.
8. Review of changed data classifications, audit events, retention behavior, and permissions.

---

## 12. Critical path & recommended build order

```text
Phase 0 (threat model + ADRs) + Phase 1 (timeouts + RLS harness + error taxonomy)
  -> Phase 2 hardening (fuzz + immediate revocation)
  -> Phase 3 (assistants + publish) + Phase 4 (conversations/messages/runs/events)
  -> Phase 5 (MCP authority host + lease/capability)
  -> Phase 6 (generic outbox/inbox + tiered idempotency + dispatcher)
  -> Phase 7 (artifacts/uploads/knowledge/pgvector + memory)
  -> Phase 8 ledger completion (immutable usage_ledger + provider reconciliation)
  -> Phase 9 (retention/export/hold/purge evidence)
  -> Phase 10 (ASVS, DR drills, SLOs, chaos)
  â”€â”€ Phase 11 only from measurement (Debezium/OpenFGA/cells/vector/sandbox/service split)
```

This is the same path as `engine_implementation_plan.md:711-726`:

```text
threat model and platform kernel
  -> identity/tenancy/RLS
  -> assistant versioning and policy
  -> conversations/messages/runs
  -> Neryva MCP authority
  -> outbox/inbox and workers
  -> files/knowledge
  -> billing/usage
  -> lifecycle/audit
  -> hardening/DR
```

**Do not** begin with billing UI, a large tool catalog, arbitrary customer code, or microservice decomposition `engine_implementation_plan.md:727`.

**Suggested next 3 PRs:**

1. `0.5 + 1.2` â€” statement/idle timeouts + release-job migration runner + RLS harness (`withOrg`/`withBypass` docs) â€” closes Phase 1 exit gates.
2. `3.1 + 3.7` â€” `assistants`/`assistant_versions`/`policy_snapshots` + legacy `agent-studio` rename â€” proves immutable publish + pin.
3. `4.1-4.8` â€” `conversations`/`messages`/`runs`/`run_events` + `outbox_events` (generic) + `start-message TX` + `CommitRunResult` stub â€” first end-to-end (user message â†’ queued run â†’ fake Studio).

---

## 13. Definition of Done â€” Engine is production-ready `engine_implementation_plan.md:10-26`

- [ ] Cross-tenant read/mutate blocked on every public, MCP, worker, object, search, and cache path.
- [ ] PostgreSQL constraints + RLS pass for `application` / `worker` / `table-owner` / `BYPASSRLS` scenarios.
- [ ] User-message acceptance + `run` creation + outbox publication are atomic (single TX).
- [ ] Duplicate API requests / broker redelivery / worker retry / provider retry cannot duplicate user-visible messages or billable effects.
- [ ] Crashed worker can resume/reconcile every supported operation.
- [ ] Agent Studio communicates only through versioned `neryva.mcp.v1` + scoped capability.
- [ ] Public API schemas, error codes, pagination, idempotency, concurrency, and event cursors documented and tested.
- [ ] Assistant versions, policies, usage, audit, exports, and deletions have explicit lifecycle semantics.
- [ ] Files are private, scanned, checksum-verified, tenant-bound, never parsed in API process.
- [ ] Sensitive data is encrypted in transit/at rest; secrets never in plaintext config or logs.
- [ ] Restore/replay/deletion/reconciliation drills passed in isolated environment.
- [ ] Security, load, chaos, supply-chain checks run before every release.

---

## References

- `engine_architecture.md:157-177` â€” authority matrix & service identities.
- `engine_data_and_lifecycle.md:430-445` â€” consistency summary (single source for transaction/outbox/lease/fencing rules).
- `engine_implementation_plan.md:606-635` â€” API & event contract checklists.
- `../products/neryva_mcp/neryva-mcp-contract` (sibling of `engine/`) — canonical `neryva.mcp.v1` contract (consume via generated package, do not copy).
- `docs/architecture/main.md:237-313` â€” Neryva MCP flow + capability semantics for Engineâ€“Studio.
- `ownership-map.json:1` â€” migration ownership (only `engine-ts` tables altered by `engine/` migrations).

