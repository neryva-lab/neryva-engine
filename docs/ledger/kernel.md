# Ledger — kernel (`src/common`, the shared kernel / enforcement layer)

**Namespace:** cross-cutting (no routes of its own except `/health/**`) · **Spec:** [`dev/modularity/plan.md`](../dev/modularity/plan.md) §3 (locked list), M1–M2 · **Tier:** 0+1 ([partitioning](../architecture/partitioning.md)).
**Current state (verified):** nothing exists — the TS engine is greenfield; the kernel's behavioral spec is the Python backend's cross-cutting layers (auth.py guards, policy interceptor semantics, audit chain, rate limiter, error envelope).

## Phases

### K-1 — Engine bootstrap (modularity M1)
- [ ] NestJS app with Fastify adapter in `engine/src`; joins the root pnpm workspace
- [ ] CI job: lint (ESLint + boundaries) + typecheck + Jest — green on a skeleton
- [ ] `/health/live` responds; `/health/ready` scaffold (aggregates module probes)
- [ ] `main.ts`/`app.module.ts` are assembly-only (no logic) — enforced by review checklist
- **Gate:** CI green end-to-end; health responds in a container built from `ops/docker` parity Dockerfile

### K-2 — Boundary enforcement from day one
- [ ] `dependency-cruiser` + `eslint-plugin-boundaries` configured: kernel imports no module; modules import kernel + allowed public interfaces only; products never import products
- [ ] CI fails on a violating import (verified with a deliberate scratch violation)
- **Gate:** boundary rules active in CI

### K-3 — The five token guards (M2)
- [ ] `L2ApiKeyGuard` — verifies `nrv_live_` keys against the **existing** `api_keys` table (SHA-256 lookup, revocation/expiry, per-key rate limit semantics)
- [ ] `L4EndUserTokenGuard` — Fernet semantics ported against existing `session_tokens` rows (tenant/surface/device binding, revocation check)
- [ ] `L5AgentIdentityGuard` — hashed short-TTL bearers per the 0015 pattern
- [ ] `L1JwtGuard` — placeholder until [`identity`](identity.md) OP exists; activated in I-1c
- [ ] Step-up MFA guard (X-MFA-Proof HMAC semantics)
- **Gate:** each guard unit-tested against fixtures of the live schema (Python still owns writes during migration)

### K-4 — Policy, audit, envelope, idempotency (M2)
- [ ] Deny-by-default policy interceptor (Python `PolicySet.evaluate_with_results` semantics as spec)
- [ ] Hash-chained audit emitter (port of AuditRepository semantics; every privileged act)
- [ ] One error envelope + request-id propagation; `Idempotency-Key` handling on mutating public routes
- [ ] Rate-limit decorators (IP/account classes) on Redis
- **Gate:** interceptor + audit parity tests (same inputs → same decisions/hash-chain shape)

### K-5 — Runtime config & self-checks
- [ ] Typed env config + per-module flags (`MODULES__<NAME>_ENABLED`)
- [ ] Startup self-checks: route↔manifest bijection, flag matrix, migration-ownership-map consistency
- [ ] Per-module health indicators wired into `/health/ready`
- **Gate:** boot fails loudly on an undeclared route or inconsistent ownership map
