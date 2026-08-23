# ADR-005 — The Engine Is TypeScript on NestJS; the Python Backend Migrates by Strangler

**Status:** Accepted · **Date:** 2026-08-23 · **Decided by:** owner ("we will be using TypeScript + the best framework — express, nest, or any other")
**Changes:** the *implementation language* of everything in `engine/docs/dev/`. The workstream plans' **logic stands unchanged** (schemas, state machines, flows, gates) — they become the **behavioral specifications for the TypeScript build**. Where this ADR disagrees with a plan's implementation details, this ADR wins.

## D1 — Framework: NestJS (Fastify adapter)

Rationale (research-grounded, 2026-08-23):
- **Modules are first-class bounded contexts** — DI + module encapsulation map exactly to our module model ([modular monolith in NestJS](https://docs.synapsestudios.com/implementation/frameworks/nest/modular-monolith): boundaries by business capability, export only public interfaces).
- **Guards/interceptors/pipes map to our auth and policy model**: L1–L5 token layers become Nest guards; the deny-by-default policy engine becomes an interceptor chain; step-up MFA a guard.
- **The pinned contract survives**: `@nestjs/swagger` generates the OpenAPI spec — the 103-path contract remains the seam and the CI pin.
- **Batteries for the whole design**: `oidc-provider` (the battle-tested OP library) for the first-party identity provider; BullMQ for namespaced queues; Prisma (or Drizzle) for Postgres+RLS; Jest; terminus health; built-in microservice mode = the documented extraction path (ADR-003).
- **One language across the company** (web app, widget, engine) and **neryva_backend ports almost 1:1** (Express controllers → Nest controllers).
- Rejected: raw Express/Fastify (fast but structure is DIY — we'd rebuild Nest poorly), staying Python (owner decision; single language; documented as the fallback in D5).

## D2 — The Python backend is not thrown away; it migrates by strangler

The Python engine (`products/neryva_agent_studio/backend` — 218 files, the full runtime) keeps serving production while the TS engine grows around it, **one module at a time**, behind a reverse proxy that flips path namespaces:

- **The seam is the pinned contract** (103 paths, unchanged) + the shared Postgres/Redis.
- **Parity gates per module flip:** (1) contract snapshot diff = zero for migrated paths; (2) acceptance tests ported from the Python suite (its tests are the spec) pass; (3) shadow-run (mirrored traffic) comparison clean; (4) load/latency parity.
- **Net-new modules are built in TS directly** (no port at all): corporate, identity, organizations, control-plane, deployment — the Python plans for these were never implemented, so they simply become build specs.
- **The runtime plane ports last, subsystem by subsystem** (session engine → gateway → guardrails → governance), Python serving each until its flip.

## D3 — Data: one Postgres, one schema authority at a time

Alembic remains the schema authority for existing tables until a module's tables are TS-owned; each flip hands **named tables** to TS migrations (Prisma migrate), recorded in a **migration-ownership map** (a file both engines read; two systems never own the same table). RLS policies carry over verbatim.

## D4 — Repository shape during migration

```
neryva_studio/
├── engine/                  ← the TypeScript engine (NestJS; src/ + docs/)
│   └── src/{common, modules/{identity,organizations,console,corporate,agent-studio,deployment}, runtime/}
├── products/neryva_agent_studio/backend   ← the Python engine: SPEC + production runtime until retirement
└── (proxy: ops/ — path flips per module)
```

## D5 — The documented fallback

If the runtime port stalls, the stable end-state is **hybrid**: TS control plane + Python runtime, two deployables, one contract, one database — still "single engine" at the API surface. This exit ramp is recorded so the project never faces a big-bang cliff.

## Consequences

- The runtime port (gateway/guardrails/governance/session engine ≈ the hard 80%) is a multi-month track — started only after the net-new modules ship (which deliver customer value first: login, console, products, corporate).
- Zero production risk during migration (Python serves everything not yet flipped; any flip reverts by proxy rule).
- The engine docs' path references (`backend/…`) now mean "the Python spec/production instance"; TS implementation references are `engine/src/…`.
