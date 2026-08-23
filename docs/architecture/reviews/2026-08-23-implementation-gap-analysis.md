# Feature Gap Analysis — Engine vs. Production-Grade Enterprise Requirements

**Date:** 2026-08-23 · **Supersedes:** the earlier draft of this file (which led with process items — wrong emphasis; this version is a functional audit)
**Method:** every "implemented" and "missing" claim below was verified against the engine source this session (all 10 modules under `src/modules/`, kernel under `src/common/`, migrations `eng-0001…0007`), cross-checked against the promised capabilities in the architecture layer: [product-integration inheritance list](../console/product-integration.md), [access-model](../console/access-model.md), identity architecture (final_analysis 06), [END-TO-END auth map](../../dev/END-TO-END.md) §2, and the platform benchmarks (final_analysis 07).

> **2026-08-23 (late) — IMPLEMENTED THIS SESSION:** all 9 BLOCKERS and all 5 "surprises" now have end-to-end code: password reset + email verification + session management (`account.controller`, eng-0010) · TOTP enrollment/recovery codes/proof minting (`mfa.service`, `totp.ts`) · org deletion with staged grace + purge worker + ownership transfer (`org-lifecycle.service`, eng-0012) · route↔manifest bijection boot enforcement (`route-bijection.service` + main.ts onRoute) · price catalog + derive/enforce ingest cost validation (`price-catalog.service`, eng-0011) · proxy `/v1/deployments` exception (Caddyfile) · satellite revocation feed (`revocation-log.service`, `/internal/revocations`) · metrics plane (`common/observability`, `/metrics`, HTTP/auth/ingest/deployment/webhook instrumentation) · webhook subsystem (`modules/webhooks`: HMAC signing, retries, DLQ, SSRF guard) · notification service (`modules/notifications`: feed + email fan-out) · auto-promote stage chaining + env pinning + failure events (deployment workflow) · staff overlay (`modules/staff`: org search/detail, audit query+verify, feature flags, READ-ONLY impersonation via OP-signed `imp` tokens). Payment provider decided: **Stripe** (Wave D, seam documented in the billing README). All of it is WRITTEN-UNVERIFIED (no build/test run yet) and uncommitted.

**Severity scale**
- **BLOCKER** — cannot serve real users without it (security hole, dead-end flow, or unmanageable system)
- **HIGH** — enterprise customers hit it in the first weeks; missing it is a support/incident liability
- **ROADMAP** — planned-by-ADR later work (listed so scope is honest, not forgotten)

---

## 1. Identity & Access (`modules/identity`) — *the account is the product's front door*

**Implemented (verified):** email+password (argon2id) · email one-time-code login · first-party OP (Authorization Code + PKCE, refresh rotation with reuse detection, JWKS dual-key rotation, RFC 7009 revoke, discovery) · L1 session verification with sid deny-list + registry fallback · step-up MFA proof (HMAC, TTL-capped) · account creation → personal org autocreation · service-client seeding (L3-lite).

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| I-1 | **Password reset flow** | BLOCKER | No forgot-password → emailed token → reset endpoints anywhere (`account_recovery_codes` table exists, nothing uses it). A locked-out user has no recovery path. |
| I-2 | **Email verification flow** | BLOCKER | `accounts.email_verified_at` column exists; no verification endpoint, no resend-with-cooldown. Unverified email + password login = deliverability and account-claiming hole. |
| I-3 | **Change password / change email** | HIGH | No re-authenticated credential-change endpoints. |
| I-4 | **TOTP MFA enrollment & verification** | HIGH | Step-up proof verifies a header, but nothing enrolls a TOTP secret (`account_credentials` kind `totp` never written). Users cannot actually *have* MFA — only the proof machinery exists. |
| I-5 | **Recovery codes generation/redemption** | HIGH | Table + schema only; no generate-on-enroll, no redeem-during-step-up. |
| I-6 | **Session management surface** | HIGH | No list-my-sessions, revoke-one-session, logout-all-devices endpoints (the internal `sessions_revoked_at`/event machinery exists — the user-facing surface does not). |
| I-7 | **Account profile & lifecycle** | HIGH | No update display name, delete account, export-my-data (GDPR erasure/portability). |
| I-8 | **Account lockout / progressive throttle** | HIGH | Email codes have per-account/IP buckets; password attempts and OP endpoints have only generic rate limits — no lockout state, no notify-on-lockout. |
| I-9 | **WebAuthn/passkeys, social federation** | ROADMAP | I-2+ per ledger — fine to defer, listed for honesty. |
| I-10 | **Inbound SAML/SCIM for enterprise tenants** | ROADMAP | Access-model Δ8 (SSO-required orgs, bounded revocation windows). Enterprise tier will demand it. |
| I-11 | **Full RFC 8693 token exchange** | ROADMAP | L3-lite covers satellites; acting-for-user chains come with product-to-product reads. |

---

## 2. Organizations & Tenancy (`modules/organizations`)

**Implemented:** memberships + 5 roles · invites (hashed single-use tokens, expiry, attempt caps, email-bound redemption) · projects (create/list/archive) · entitlement state machine (audited, explicit transition table) · org contexts (picker) · audit view · exactly-one-owner invariant.

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| O-1 | **Org settings management** | HIGH | No update-org endpoint (name, slug). Orgs are created once and frozen. |
| O-2 | **Org deletion** | BLOCKER (compliance) | Access-model lists it (owner + MFA proof); no endpoint, no cascading data lifecycle. GDPR erasure impossible at org level. |
| O-3 | **Ownership transfer** | BLOCKER (operability) | Access-model lists it (owner + MFA); missing. An org whose owner leaves is unowned forever. |
| O-4 | **Seat limits per plan** | HIGH | `limits` jsonb supports `max_members`; nothing enforces it at invite/create time. |
| O-5 | **Pagination/search/filter on members, invites, audit** | HIGH | All lists unbounded (audit hard-capped at 100). Enterprise orgs exceed that on day one. |
| O-6 | **Audit log filtering + export** | HIGH | No actor/action/date filters, no CSV/JSON export. Compliance reviews need them. |
| O-7 | **Project rename/update** | MEDIUM | Create/archive only. |
| O-8 | **Invite resend + pending-invites-for-me** | MEDIUM | No resend with cooldown; no invitee-side "your pending invites" query. |
| O-9 | **Role-change notifications** | MEDIUM | Role/ownership changes are audited but never emailed to the affected member. |

---

## 3. API Keys & Service Identity (`modules/keys`)

**Implemented:** issue (step-up-gated, raw key shown once) · list · revoke · `/internal/keys/validate` for satellites · per-key rate limit in the L2 guard · usage counters (last_used_at, usage_count).

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| K-1 | **Key update (rename/scope-change)** | HIGH | No endpoint; scope mistakes require revoke+reissue. |
| K-2 | **Project binding at issue time** | HIGH | `project_id/owner_account_id/org_id` columns wait on Alembic 0017; the issue DTO can't take a project. (Studio bindings exist separately — two-step UX.) |
| K-3 | **Per-key usage analytics** | HIGH | Counters exist; no per-key usage/spend report endpoint. Customers ask "what is this key doing" constantly. |
| K-4 | **Expiring-key alerts** | MEDIUM | `expires_at` enforced at auth; nothing warns owners before expiry. |
| K-5 | **IP allowlisting per key** | ROADMAP | Standard enterprise ask. |
| K-6 | **Key events to owner** (issued/revoked/expired emails) | MEDIUM | Audit rows only; no notification. |

---

## 4. Console & Product Platform (`modules/console`)

**Implemented:** manifest registry (validated, staged lifecycle, satellite vs engine runtime routes) · `/console/home` with per-product cards (entitlement-state rendering, role-aware CTAs, empty-KPI fallback) · cached summary providers with invalidation on entitlement transitions · nav model · inference pre-registered.

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| C-1 | **Route↔manifest bijection enforcement at boot** | BLOCKER (contract integrity) | The 404 rule ("undeclared surface is impossible") is design, not code: nothing verifies Nest's registered routes against manifest `console.base_route`/`runtime_routes`. A shadow route ships silently today. |
| C-2 | **Product alert roll-up in the shell** | MEDIUM | Cards carry alerts; no cross-product notification center. |
| C-3 | **Onboarding state** | MEDIUM | No first-run flags (has project? has key? has entitlement?) for guided setup. |

---

## 5. Metering, Billing & Quotas (`modules/billing`)

**Implemented:** idempotent satellite ingest (`(source,event_id)` unique, manifest-validated tags, per-row rejection) · six-level quota hierarchy with atomic Lua reservation at product+project · ledgers per (org×product) with entitlement join · invoices (draft/issue/pay/void machine) · usage overview/slices/series/rollup (rollup = only cross-product endpoint) · daily cost-anomaly job with product-labeled alerts.

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| B-1 | **Price catalog / cost validation** | BLOCKER (trust) | `cost_usd` is *trusted as-sent by the satellite*. A mispriced or malicious emitter writes arbitrary billing truth. Enterprise grade requires a platform-owned rate card (per model/product) and validation-or-derivation of cost at ingest. |
| B-2 | **Automatic period invoicing** | HIGH | Invoice drafts are manual (`POST …/invoices`); no month-end job per ledger. |
| B-3 | **Usage thresholds & budget alerts** | HIGH | Quota *reservations* hard-stop, but nothing notifies at 50/80/100% of spend — the single most-requested billing feature. No per-project budget objects at all. |
| B-4 | **Payment provider integration** | ROADMAP | Plan-of-record defers it (ledger records only) — but invoice `pay` is currently a manual truth-assertion endpoint; needs role + audit tightening when Stripe-class integration lands. |
| B-5 | **Invoice documents** (PDF/line items) | HIGH | Records only; no line-item breakdown, no downloadable invoice. |
| B-6 | **Usage data export** | HIGH | No raw-events or summarized CSV/JSON export for enterprise chargeback. |
| B-7 | **Adjustments/credit notes** | MEDIUM | No correction path for bad events (only void-an-invoice). |
| B-8 | **Multi-currency / tax fields** | ROADMAP | USD-only, no tax metadata. |
| B-9 | **Reconciliation report endpoint** | HIGH | The B-4/A-3 dual-write comparison (engine vs runtime totals) — required before metering cutover; missing. |
| B-10 | **Anomaly alert delivery** | HIGH | Anomalies emit on the in-process bus + audit; no email/webhook sink — nobody is told. |

---

## 6. Agent Studio furniture (`modules/agent-studio`)

**Implemented:** manifest (stage `ga`, runtime external) · studio plans catalog (trial limits → quotas) · trial start (owner/billing + step-up) · summary card (conversations 7d, projects, month spend) · project usage slices + quota snapshot · key↔project bindings (engine-owned, audited) · runtime deep links.

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| S-1 | **Studio-facing webhooks** | HIGH | The manifest nav promises a `webhooks` page; **no webhook subsystem exists anywhere in the engine** (see §10-P1 — platform-level feature). Studio customers cannot receive conversation/agent events. |
| S-2 | **Studio spend alerts** | MEDIUM | Same threshold gap as B-3, scoped to the product card. |
| S-3 | **Agent count KPI** | MEDIUM | Active-agents KPI needs the runtime observability feed (A-3/A-4) — placeholder documented, listed. |
| S-4 | **Eval-results pointer deep links with auth** | MEDIUM | Pointers are static URLs; deep-linking into satellite surfaces with SSO is unbuilt (rides A-2). |

---

## 7. Deployment product (`modules/deployment`)

**Implemented:** pipelines + stages (gate policy JSONB) · environments (plan-ceiling enforced) · deployment runs with explicit status machine (one guarded path for worker + console) · gate evaluator (fail-closed on unknown metrics, awaiting vs failed, approval quorum) · canary ladder 10/50/100 with per-weight re-evaluation · manual approve · metrics feed endpoint · instant rollback · secrets vault (envelope-encrypted, rotate/remove, no plaintext ever returned) · cost view · per-run metered event tagged `deployment` · runtime plane `POST /v1/deployments` (L2 `deployment:operate`, tenant-bound, entitlement-checked).

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| D-1 | **Proxy route exception for `/v1/deployments`** | BLOCKER | Caddyfile sends all `/v1/*` to the runtime; the engine-owned runtime plane is unreachable behind the proxy. One-line fix; shipping without it means the product's runtime API does not exist in the composed deployment. |
| D-2 | **Stage chaining / auto-promote** | HIGH | `pipeline_stages.auto_promote` is stored but never consumed — finishing a stage never triggers the next. Pipelines are currently single-stage pipelines with extra steps. |
| D-3 | **Automated canary observability feed** | HIGH | Canary metrics arrive only via the manual console endpoint; no collector reads the runtime metrics plane. Without it, canary always parks in `awaiting` or passes on empty policies. |
| D-4 | **Alerts: threshold rules + channels** | HIGH | D-5's alerts surface — rules, evaluation, notification channels — entirely missing. |
| D-5 | **L5 runner identity minting** | HIGH | C18: blocked until A-1 completes; workflow acts as system principal (documented). Runner-level authz for stage actions is future. |
| D-6 | **Agent-config snapshot from the runtime (L3 read, acting-product audited)** | MEDIUM | Snapshot is caller-provided today; the outbound public-contract read is unbuilt. |
| D-7 | **Blue-green reality** | MEDIUM | Single cutover event; no dual-running environment or traffic-switch semantics — either build or restrict to `all|canary` in validation. |
| D-8 | **Stage reorder/edit/remove; pipeline update** | MEDIUM | add-stage only. |
| D-9 | **Deployment cancel/pause** | MEDIUM | Only rollback exists. |
| D-10 | **Retention enforcement** | MEDIUM | `retention_days` stored, no cleanup job for runs/events. |
| D-11 | **Environment infra status page** | MEDIUM | D-5 "Infrastructure" — what serves each env — needs the satellites/status join. |
| D-12 | **Secrets fetch-for-runner (L5) endpoint** | MEDIUM | Deliberately deferred with L5; listed. |
| D-13 | **Deployment notifications** (status-change emails/webhooks) | MEDIUM | Events logged only. |

---

## 8. Corporate: email, public forms, content (`modules/corporate`)

**Implemented:** email transport port (file/resend/postmark) + templates + delivery audit · public forms with IP token-buckets, Idempotency-Key, honeypot-invisible rejection · newsletter double opt-in · content posts CRUD + publish/archive + content-staff role management (super_admin-gated).

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| E-1 | **Inbox management for submissions** | HIGH | Contact/career/newsletter rows are stored; no staff list/filter/resolve/reply surface — the data lands and rots. |
| E-2 | **Newsletter subscriber management** | HIGH | No admin list/export/unsubscribe handling. |
| E-3 | **Content workflow depth** | MEDIUM | No drafts→scheduled publish (`publish_at`), revisions, or unpublish-to-draft. |
| E-4 | **Build-time content export** | MEDIUM | E-3's static-rendering export for the website — not implemented. |
| E-5 | **Email bounce/complaint webhooks + suppression list** | HIGH | Provider webhook ingestion, suppression, re-verification — absent; sender reputation will degrade silently. |
| E-6 | **Attachment handling for careers** | MEDIUM | Plan says "file refs only"; no upload/ref flow exists. |
| E-7 | **Mongo→Postgres migration + neryva_backend retirement** | HIGH | E-5/E-6 of the ledger (script + reconciliation + retirement checklist) — not started (correctly sequenced, but it is the remaining corporate work). |

---

## 9. Satellite operations & config publishing (`modules/satellites`, `modules/config-publish`)

**Implemented:** satellite registry (agent-runtime live, inference placeholder) with heartbeats (self-identity-enforced) + staff status view · config publish (step-up-gated) with versioned pull + latest + ACK + durable notification ledger.

**Depth pass 2026-08-24 (config-publish v2, eng-0016):** X-4 closed — per-scope strict payload schemas (policy/guardrail/quota/model-catalog, `.strict()`, wire-capped; invalid configs cannot publish), the draft→validate→publish→rollback editor (invalid drafts persist with their report; rollback = new version restoring old payload), history/diff/version reads, bootstrap pull (one-shot cold sync), ETag/304 on latest, paginated catch-up (`nextSince`/`hasMore`), per-satellite delivery view with registry liveness, re-notify, `config.published` webhook push, and retention sweeps (versions + acked notifications; the satellites sweeper owns config-drift incidents). Pull zone honors the satellite quarantine gate + activity counters. X-1/X-2/X-3 are the satellites track (satellites dense wave).

**Missing features:**

| # | Feature | Severity | Detail |
|---|---|---|---|
| X-1 | **Satellite revocation feed** | BLOCKER (A-2) | No endpoint for satellites to learn engine session revocations/logouts — the runtime cannot honor engine-side session kills until it exists. |
| X-2 | **Stale-satellite detection** | HIGH | Heartbeats recorded; no job flips a satellite to stale when they stop. |
| X-3 | **Connection-contract compliance view** | MEDIUM | No per-satellite evidence panel (ingest flowing? config ACK lag? validation traffic?). |
| ~~X-4~~ | **Config versioning UX** | closed 2026-08-24 | Drafts + diff + rollback + strict payload validation shipped in the v2 depth pass above. |

---

## 10. Platform services (cross-cutting — the enterprise table stakes)

| # | Feature | Severity | Detail |
|---|---|---|---|
| P-1 | **Webhook subsystem** | HIGH | Outbound webhooks (customer endpoints, HMAC signatures, retries with backoff, DLQ, delivery log, per-org endpoint management). Referenced by the studio manifest nav; **zero code exists**. Every serious platform has this; product events currently reach nobody. |
| P-2 | **Notification service** | HIGH | One engine-wide fan-out (in-app feed + email digests) that B-3/D-4/E-5/K-6/O-9 above all need. Today every alert is an audit row or an in-process event. |
| P-3 | **Staff/admin console APIs** | HIGH | Platform roles (`super_admin/tenant_admin/operator/auditor`) parse out of tokens, but the only staff surface in the entire engine is content-staff grant/revoke. No tenant/org lookup, support impersonation (audited), platform health/metrics view, or feature-flag management (`tenants.features` jsonb has no surface). |
| P-4 | **Observability plane** | BLOCKER (operability) | No metrics, no tracing, no log shipping on the engine. A production incident is undebuggable; load and SLO numbers are invisible. (Runtime has a full plane; the engine has request-ids and health.) |
| P-5 | **Audit completeness** | HIGH | Chain append + verify exist; missing: filter/paginate/export, periodic verifier job + alert on break, staff access route. |
| P-6 | **GDPR/data-lifecycle tooling** | HIGH | Account/org export & erasure, retention jobs (spend events, deployment runs, audit windows). Partially specced in tenants.retention_days — nothing executes. |
| P-7 | **Pagination/list-envelope standard** | MEDIUM | Endpoint-by-endpoint caps; no cursor pagination convention. |
| P-8 | **Idempotency coverage check** | MEDIUM | Interceptor exists; mutating endpoints missing `@Idempotent()` (e.g., key bind/unbind, secret set/rotate, approve) should be swept deliberately. |
| P-9 | **Secrets custody (KMS)** | ROADMAP | `kms_ref` column exists; envelope key is env-based. |
| P-10 | **Health/ready depth** | MEDIUM | Registry exists; verify dependency-failing readiness (Redis/DB/queue) is actually composed. |

---

## 11. Functional gaps by count (summary)

| Domain | Implemented core | BLOCKER | HIGH | MEDIUM | ROADMAP |
|---|---|---|---|---|---|
| Identity & access | ✅ solid | 2 (I-1, I-2) | 6 | — | 3 |
| Organizations | ✅ solid | 2 (O-2, O-3) | 4 | 3 | — |
| API keys | ✅ solid | — | 3 | 2 | 1 |
| Console platform | ✅ solid | 1 (C-1) | — | 2 | — |
| Billing/metering | ✅ solid | 1 (B-1) | 6 | 1 | 2 |
| Studio furniture | ✅ solid | — | 1 | 3 | — |
| Deployment | ✅ solid | 1 (D-1) | 4 | 8 | — |
| Corporate | ✅ solid | — | 4 | 3 | — |
| Satellite ops/config | ✅ solid | 1 (X-1) | 1 | 2 | — |
| Platform services | — | 1 (P-4) | 5 | 3 | 1 |
| **Total** | | **9** | **34** | **27** | **7** |

---

## 12. Build order (feature-first, dependency-aware)

**Wave A — launch blockers (identity + integrity):** I-1 password reset · I-2 email verification · O-2 org deletion · O-3 ownership transfer · C-1 route↔manifest bijection · B-1 price catalog/ingest cost validation · D-1 proxy exception · X-1 satellite revocation feed · P-4 observability plane.

**Wave B — enterprise table stakes:** I-4/I-5 real MFA enrollment + recovery codes · I-6 session management · O-5/O-6 pagination + audit export · K-2 project-scoped keys (with Alembic 0017) · B-2/B-3 auto-invoicing + budget alerts · P-1 webhooks · P-2 notifications · P-3 staff console · D-2 stage chaining · D-3 automated canary feed · E-5 email bounce handling · B-9/X-3 reconciliation.

**Wave C — depth & polish:** everything MEDIUM above (stage management, retention jobs, exports, content workflow, config UX, D-7 blue-green).

**Wave D — ADR-gated roadmap:** payment provider · SAML/SCIM · passkeys/social · token exchange · IP allowlists · KMS custody · inference.

---

*Operational prerequisites (one line each, no elaboration — they are real but not the point of this file): the tree is uncommitted with no engine remote; no dependency install/build/test/CI has ever run; test + CI + lint infrastructure is absent. Before Wave A starts, commit everything, then run install → typecheck → migrate and fix what surfaces.*
