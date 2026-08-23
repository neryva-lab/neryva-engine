# Engine Technology Stack — Plan of Record

**Date:** 2026-08-23 · **Status:** binding for the engine build
**Binding docs:** [ADR-005](../architecture/decisions/ADR-005-engine-typescript-nestjs.md) (TS/NestJS/strangler) · [ADR-006](../architecture/decisions/ADR-006-engine-core-capabilities.md) (core only) · [ADR-007](../architecture/decisions/ADR-007-legacy-backends-references.md) (references, not foundations) · [ENGINE-EXECUTION-PLAN](../dev/ENGINE-EXECUTION-PLAN.md) §2 (corrections C11/C12/C15/C16/C17)
**Scope:** the **engine** (TypeScript core). The Agent Studio backend satellite picks its own tools (only the connection contract and the one-adapter provider pattern are mandated for it — `agent-studio-backend.md` §3.2).

---

## 1. The stack at a glance

| Layer | Choice | Status | Authority / note |
|---|---|---|---|
| Language & runtime | **TypeScript** on Node LTS | Decided | ADR-005 D1 |
| Framework | **NestJS 11 + Fastify adapter** | Decided | ADR-005 D1. Keep patched (a path-canonicalization advisory affected the Fastify adapter in 11.1.13); Express adapter is the documented fallback |
| ORM | **Drizzle (default) or Kysely — Prisma only with a documented RLS pattern** | **P1 spike, gated** | Correction **C16** — see §3.1. RLS is Tier-0; the spike's gate is a failing-then-passing RLS test |
| Database | **PostgreSQL** (shared with the Python runtime during transition) + **Redis** | Decided | Migration-ownership map governs who writes which tables (ADR-005 D3; plan C6) |
| Migrations | TS-owned tables: the chosen ORM's migration tool, numbered `eng-0001…`; Python-owned tables: Alembic (Python repo only) | Decided | Plan C6. The single sanctioned Python-side migration: additive `api_keys` columns (Alembic 0017, P3) |
| Identity provider | **`oidc-provider`** (panva) with a DB adapter | Decided | §3.2 — OpenID Certified; refresh rotation with reuse detection built in; PKCE S256 |
| Token guards | `L1JwtGuard`, `L2ApiKeyGuard` (interim shared-table reads), `L3ServiceGuard` (client credentials), `StepUpMfaGuard` (net-new TS, C11); **L4 deferred** (C12); L5 engine-minted post-A-1 | Decided | Kernel K-3 as amended |
| Password hashing | **argon2id** (`node-argon2`), rehash-on-login | Decided | Doc-06 §10.1 |
| Queue / jobs | **BullMQ** on Redis, per-module namespaces (`{module}:`) | Decided | Replaces the Python QueueManager *for engine jobs* (plan C9) |
| Email | **Transport port + transactional provider API** (Resend / Postmark / SES — pick one at P1); dev transport = file/log | Decided at P1 | Correction **C15** (resolves doc-06 Q1). No self-run SMTP, ever |
| API spec | **@nestjs/swagger** export + **composition script** → `contracts/openapi.composed.v1.json` with `x-neryva-owner` bijection in CI | Decided | Correction **C7** — the Python export script cannot see engine routes |
| Crypto | `node:crypto` (HMAC proofs, constant-time compares); KMS-envelope (`kms_ref`) pattern for OP signing keys; production refuses auto-generated keys | Decided | Mirrors the runtime's `session/tokens.py` / migration-0015 disciplines |
| Fernet / L4 | **Not needed engine-side** (no `/surfaces/**` routes — satellite plane). If ever required: verify-only via `node:crypto` (AES-128-CBC + HMAC-SHA256) with Python-generated fixtures | Deferred | Correction **C12** — no maintained JS Fernet library exists |
| Observability | OpenTelemetry tracing + Prometheus metrics (semantics parity with the runtime's rails where they meet: `product` label, spend/quota metrics); `@nestjs/terminus` health | Decided | Kernel K-4/K-5 |
| Validation | Class-validator/class-transformer DTOs (NestJS-idiomatic) — confirm at P1 alongside the ORM choice | Recommended | — |
| Tests | **Jest** unit + supertest e2e + contract snapshots; acceptance tests ported from the Python suite where engine behavior overlaps it | Decided | ADR-005 D2 parity gates |
| Boundaries / lint | ESLint + `eslint-plugin-boundaries` + `dependency-cruiser` in CI | Decided | Kernel K-2 (the TS equivalent of the cancelled Python import-linter, C9) |
| Workspace | pnpm workspace at the `neryva_studio/` root (engine joins `console/`, `products/agent-studio/widget/`) | Decided | Plan P0/P1 |

**Changing anything in this table requires an ADR** (the ledger records reality, never redefines it).

---

## 2. Security floors (non-negotiable, inherited from the existing disciplines)

1. No plaintext secrets at rest — hashes for lookup artifacts (API keys, refresh tokens, invite/email codes), envelope encryption + `kms_ref` for recoverable secrets (OP signing keys, deployment secrets).
2. Production refuses auto-generated or hard-coded fallback keys (mirror `session/tokens.py` Fernet policy): missing key file = loud boot failure.
3. A token from one layer is never accepted on another layer's routes (distinct audiences/verification paths per guard).
4. RLS on every tenant-scoped table the engine creates; the database boundary stays the load-bearing wall — claims/guards are optimization and UX (doc-06 §10.8).
5. Every privileged act writes the hash-chained audit (kernel K-4).
6. OP signing keys: dual-key rotation with overlap ≥ 2× access TTL; JWKS serves `kid`-indexed public halves.

---

## 3. Decision detail & evidence

### 3.1 ORM — why the default is Drizzle (C16)

Prisma has **no native row-level-security support**. The official pattern is a Client Extension that sets `SET LOCAL app.current_tenant` inside interactive transactions, and Prisma's own docs label it *"an example only, not intended for production."* Known issues: context leaks / failures with extended clients in interactive transactions (prisma [#23583](https://github.com/prisma/prisma/issues/23583)); connection-pool context leakage when `SET` escapes transaction scope; Prisma Migrate does not manage RLS policies (hand-written SQL required); the long-open multi-tenancy request ([#2077](https://github.com/prisma/prisma/issues/2077), [discussion #20168](https://github.com/prisma/prisma/discussions/20168)).

The engine becomes a **second writer on the shared production database** during the transition, and RLS is a Tier-0 invariant ([partitioning §2](../architecture/partitioning.md)) — so the ORM must make transaction-scoped tenant context trivially correct. **Drizzle** (or Kysely) does: `set_config('app.current_tenant', …, true)` inside a transaction is first-class, migrations are plain SQL (RLS policies natural, per-product schemas natural), and multi-schema support is not a preview feature.

**The P1 spike decides, with a gate:** implement one tenant-scoped table + one query; the test suite must show the query *fails* without tenant context and *passes* with it. If the team overrides to Prisma anyway, the override ADR must accept in writing: RLS SQL in separate hand-written migration files, tenant context only via `$extends` + interactive transactions, and the #23583 risk class.

### 3.2 The OP — `oidc-provider` configuration notes

[`oidc-provider`](https://github.com/panva/node-oidc-provider) is [OpenID Certified](https://oidc-provider.dev/); refresh-token rotation with **reuse detection** (family revocation) is built in via `refreshTokenRotation`, and PKCE S256 is enforced for public clients by default. Two engine-specific configuration points:

1. **Access tokens must be JWTs** so engine resource servers verify offline via JWKS (doc-06 §6.1): enable the JWT access-token format / resource indicators for the engine-API audience.
2. **Persistence goes through its adapter interface** to the engine database — the engine is the only writer of `oauth_*` tables (migration ownership: TS from creation).

L3-lite (correction C17): add the **client-credentials grant** for `kind=service` clients (satellites) with audience validation — the connection contract needs it at P4 (metering ingest auth) — while full RFC 8693 token exchange (acting-for-user) stays deferred to I-3.

### 3.3 NestJS + Fastify

Fastify-adapter NestJS is production-viable with strong throughput (community benchmarks show 2–3× Express; [NestJS performance docs](https://docs.nestjs.com/techniques/performance), [Encore comparison](https://encore.dev/articles/nestjs-vs-fastify)). Caveats on record: Fastify support has historically had rougher edges than Express ([nestjs#9739](https://github.com/nestjs/nest/issues/9739)), and a path-canonicalization advisory affected the adapter (fixed post-11.1.13) — so: pin patched versions in CI (Renovate/Dependabot), keep the Express swap documented as the rollback.

### 3.4 Contract composition (C7)

One composed spec is the entire public surface: `contracts/openapi.composed.v1.json` = pinned runtime spec (Python export, unchanged) + engine swagger export, merged by an engine-owned script; every path carries `x-neryva-owner: platform | <product key> | <satellite key>`; CI fails on unowned paths, manifest↔contract mismatches, or cross-source path collisions. Until P4 lands, engine routes stay outside the pinned runtime spec **by construction** (separate deployables behind one proxy).

### 3.5 Email (C15)

The corporate module owns a transport port (`send(template, vars, to)`), templates (login code, invite, newsletter double opt-in), delivery-audit rows, and rate-limited sending. The production provider is a transactional API (Resend / Postmark / SES — whichever is chosen at P1; it is config-only to swap). The dev transport writes to a file/log. This unblocks identity I-1a and resolves doc-06 Q1 permanently.
