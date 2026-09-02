# Neryva Engine — STRIDE Threat Model (Phase 0.2)

- Date: 2026-09-01
- Scope: Engine control plane and system of record (does not cover Agent Studio execution plane internals, which have a separate ledger).
- Model: STRIDE per `engine_implementation_plan.md:46-55` + `engine_architecture.md:180-189, 462`. Each control has an **Owner**, a **mitigation file**, and a **verification gate** (test or runbook).
- Invariant: The 12 decisions in `engine_architecture.md:570` must not be weakened even under the mitigations below.

## Surface Inventory

| # | Surface | Principal | Data | Trust Boundary | Ledger Phase |
|---|---|---|---|---|---|
| S1 | Browser / channel adapter → Engine API | End user (`L1` JWT) / channel actor | Conversation messages, profile, knowledge reads | WAF → `engine-api` | 0, 1, 4 |
| S2 | Public REST API (`/api/v1`) | `L1` JWT / `L2` `nrv_live_` / `L2` `nrv_sa_` | Tenant-owned resources, upload sessions | `AuthGuard` → `OrgRolesGuard`/`EntitlementGuard` | 1, 2, 3, 4 |
| S3 | Service identities | `L3` JWT (`agent-studio-runtime`, `engine-worker`, `billing-reconciler`, `support-operator`) | Runs, usage, admin ops | Workload mTLS / IdP-issued JWT → `SERVICE_CLIENT_PORT` | 0, 2, 5 |
| S4 | Neryva MCP (`neryva.mcp.v1`) capability tokens | `agent-studio-runtime` with run-scoped capability (`aud=neryva-agent-studio`) | Context, events, checkpoints, tool approvals | `@connectrpc/connect-fastify` interceptor chain | 5 |
| S5 | PostgreSQL (managed HA) + RLS | `application` / `worker` / `owner` / `BYPASSRLS` roles | Tenant rows, migrations, audit chain | `withOrg` / `withBypass` (`db.service.ts:54`), `FORCE RLS` | 1, 3, 4, 6 |
| S6 | Object storage (S3/MinIO/R2) + presigned URLs | `L1`/`L3` authorized bearer of a temporary capability, not a tenant DB row | Blobs, exports, checkpoints | `StorageService` (`storage.service.ts:43`) → private buckets | 7 |
| S7 | Queues / outbox-inbox / event replay | `engine-dispatch` / `engine-worker` consumers | `outbox_events`, `inbox_events`, `run_events` | `FOR UPDATE SKIP LOCKED` + `consumer_name+event_id` inbox | 6, 4 |
| S8 | Provider & billing (Stripe / model catalog) | Webhook caller (Stripe signature) / internal `price_catalog` | Invoices, meter events, entitlements | `BILLING_COST_VALIDATION` (`env.ts:71`) + webhook HMAC | 8 |
| S9 | Support / operator access | `support-operator` human (`L1` with `PlatformStaffGuard` + `StepUp`) | Read access, impersonation, export/deletion | `staff_impersonations` (`0011`) + `legal_holds` | 2, 9, 10 |

## STRIDE per Surface

### S1 — Browser / Channel Clients

| Threat | Example | Mitigation | Owner | Gate |
|---|---|---|---|---|
| **S** Spoofing | Forged OIDC token, stolen cookie | OIDC `iss/aud/sig/skew/nonce/state/exp/key-rotation` validated at `src/common/auth/auth.guard.ts:1`; same-origin → `HttpOnly`/`SameSite` cookies + CSRF; account-local mapping via `(iss, sub)` never email (`src/modules/identity/*`) | Identity | `tests/integration` OIDC + key-rotation |
| **T** Tampering | Modified `conversation_id` in body | AuthZ re-checks `organization_id` on every op + RLS `current_setting('app.current_tenant')` (`db.service.ts:54`) | Organizations | `tests/isolation` cross-tenant fuzz |
| **R** Repudiation | User denies sent message | Hash-chained `audit_events` (`audit.service.ts:12`) + `canonicalUtcIso` | Audit | `verifyChain` green |
| **I** Disclosure | Prompt / token in logs | Redaction denylist at `logger.ts:1` (`password`, `secret`, `token`, `authorization`, `x-mfa-proof`, `x-api-key`, `x-webhook-secret`, `x-turnstile-token`) + `tracing.ts:17` OTel allowlist | Observability | `grep -r` no secret in logs |
| **D** DoS | Large body / fast reconnect | `ValidationPipe` `whitelist:true`/`forbidNonWhitelisted:true` + per-route `zod` size caps + `RateLimitGuard` (route-family, org/principal/credential) | HTTP | Load test |
| **E** Elevation | Channel actor escalates to `org_admin` | Role checks via `OrgAccessService.getMembershipRole` → `OrgRolesGuard`; Studio proposal never auto-truth (`engine_architecture.md:570:5`) | Authorization | `tests/isolation` multi-role × two orgs |

### S2 — Public API

| Threat | Mitigation | Owner |
|---|---|---|
| Unvalidated route handler | Every route declares JSON Schema (request/response), rate-limit class, data classification — CI blocks otherwise (`imp/ledger.md:0.1` exit gate) | HTTP |
| Idempotency confusion | Tiered `Idempotency-Key` (`idem:{principal}:{key}` Redis + `idempotency_records` UNIQUE `org+principal+endpoint_family+key` `engine_architecture.md:243`) — same key + different hash → `409` | Transactional |
| Stale-write overwrite | `If-Match`/`version` (`engine_architecture.md:252`) → `409` typed conflict | Domain |
| Cursor enumeration | Opaque cursor, no sequential IDs exposed (`engine_data_and_lifecycle.md:31`) | API |

### S3 — Service Identities

| Threat | Mitigation | Owner |
|---|---|---|
| Shared API key | Four separate workload identities (`engine_architecture.md:180-189`) with least-privilege roles: `agent-studio-runtime` (scoped MCP only), `engine-worker` (job families), `billing-reconciler` (usage-only), `support-operator` (human). Network location is not authorization. | Identity |
| Stolen worker credential | Short-lived `L3` JWT + rotation without restart; `withBypass` only in `revocation-log.service.ts` / invite redemption — never on untrusted paths | Infra |

### S4 — Agent Studio + Neryva MCP Capability Tokens

| Threat | Mitigation | Owner |
|---|---|---|
| Scope widening | Capability binds `aud=neryva-agent-studio`, `org`, `conversation`, `run`, `assistant_version`, allowed ops, `capability_id`/`nonce`, short `exp`, `iss`/`kid`, optional `lease_epoch`; every RPC re-authorizes (`neryva_mcp_implementation_plan.md:682-718`) — `app.engine_bypass` never set from Studio | MCP |
| Replay | `capability_id` + `idempotency_key` + `lease_epoch` checked; terminal `run` rejects later mutations | Runs |
| Large payload via MCP/Temporal | `ArtifactRef` with 7 facade checks + 8-field proto (`sha256` 32 bytes at schema boundary); no raw document/secret/unbounded prompt in RPC/workflow args (`engine_architecture.md:570:10`) | Knowledge |
| Forged `engine_sequence` | Engine sequence authoritative; producer-local sequence is diagnostic (`engine_data_and_lifecycle.md:188`) | Events |

### S5 — PostgreSQL + RLS

| Threat | Mitigation | Owner |
|---|---|---|
| App bug leaks tenant rows | Shared tables with mandatory `organization_id` + `ENABLE + FORCE RLS` (`drizzle/0002_org_furniture.sql:68`) + explicit app predicate on every query. Runtime roles do not own tables and lack `BYPASSRLS`. Tests cover `application` / `worker` / `owner` / `BYPASSRLS` separately (`imp/ledger.md:1.4`). | DB |
| Connection leak of `app.current_tenant` | `set_config('app.current_tenant', orgId, true)` — `true` = transaction-local (`db.service.ts:54`); context cleared before pool reuse | Infra |
| Expensive RLS subquery hides auth bug | Policy stays simple `current_setting('app.current_tenant')`; mutable-relation policies require explicit `FOR UPDATE` / `SERIALIZABLE` with bounded retry | DB |

### S6 — Object Storage + Signed URLs

| Threat | Mitigation | Owner |
|---|---|---|
| Cross-tenant object read | Keys `org/{orgId}/{purpose}/{uuid}` (no user filename), prefix validated server-side | Storage |
| URL reuse / method swap | Presigned scope binds exact key + method + `Content-Length`/`checksum` + 5–15 min TTL (`storage.service.ts:43`); multipart `abortIncompleteMultipartUpload` via `engine-jobs` | Storage |
| Plaintext provider secret in DB | `ENGINE_ENCRYPTION_KEY` → envelope (`enc:v1 AES-256-GCM`, `KMS/Vault Transit` preferred) — missing key in production is boot failure (`env.ts:192`) | Secrets |

### S7 — Queues / Outbox / Event Replay

| Threat | Mitigation | Owner |
|---|---|---|
| Fact published but consumer never runs (crash after commit before dispatch) | `outbox_events` in same TX as fact (`engine_architecture.md:570:7`); `engine-dispatch` claims `PENDING → CLAIMED` (`FOR UPDATE SKIP LOCKED`) with exponential backoff + dead-letter + operator replay (`engine_data_and_lifecycle.md:219`) | Async |
| Duplicate delivery → duplicate message / bill | Inbox `(consumer_name, event_id)` UNIQUE before side effects + domain uniqueness + tool keys (`engine_data_and_lifecycle.md:233`) | Async |
| Poison message loops | Dead-letter after threshold, `next_attempt_at` jitter, per-tenant fairness so one org does not starve others | Workers |

### S8 — Provider & Billing Integrations

| Threat | Mitigation | Owner |
|---|---|---|
| Untrusted satellite cost | `billing.price_catalog` authoritative; `BILLING_COST_VALIDATION` `derive`/`enforce` (`env.ts:71`) — `enforce` rejects >10% deviation when derivable | Billing |
| Webhook spoofs entitlement | `STRIPE_WEBHOOK_SECRET` HMAC validated before TX commit; webhook is inbox `received → signature_validated → DEDUPLICATED → PROCESSED` (`engine_data_and_lifecycle.md:346`) — never grants entitlement before commit | Billing |
| Outage breaks quota decisions | Entitlement snapshot governs rejection during provider outage; never block user message on live invoice provider if snapshot allows it (`engine_architecture.md:422`) | Billing |

### S9 — Support / Operator Access

| Threat | Mitigation | Owner |
|---|---|---|
| Operator masquerades as customer | `support-operator` is human principal with explicit `PlatformStaffGuard` + `StepUp` (MFA proof `src/common/auth/mfa-proof.ts`); `staff_impersonations` `OP`-signed `imp/act` claims with `expiresAt`; `OrgRolesGuard:49` blocks `!GET` under `principal.imp` | Staff |
| Operator exports/deletes without audit | Every privileged decision writes to hash-chained `audit_events` (`audit.service.ts:12` + `pg-types.ts:1`), read/export audit separated (`engine_architecture.md:484`) | Audit |

## Threat-Model Maintenance (control → test/runbook)

Each row above links to a gate in `imp/ledger.md`:

- Cross-tenant fuzz is `2.6 → tests/isolation`.
- Outbox lag / dead-letter, provider outage, cache/broker/IdP degradation, `kill -9` after each durable write are `6.x / 10.x → tests/chaos` + `ops/runbooks`.
- Migration ownership (`ownership-map.json:1`) + `retention_class` + `legal_holds` (Phase 9) prevent silent data exposure via derived stores.

Update this file when a new surface, role, or retention class is added — it is a living threat model, not a one-time artifact.
