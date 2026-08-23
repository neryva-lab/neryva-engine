# Ledger — inference (capability deployment #2 — future, trigger-gated)

**Status:** PLACEHOLDER — pre-registered so the pattern is fixed before the pressure arrives. **Binding:** [ADR-006 D2/D4](../architecture/decisions/ADR-006-engine-core-capabilities.md) — the connection contract is settled; the service itself opens on a business trigger (e.g., serving our own/hosted models: GLM-family, fine-tunes, batch inference).

## What it will be

A **separate deployment** providing inference only — model serving, endpoints, GPU scheduling, batching: entirely its own engineering concern. It will **never** own users, accounts, billing, console UI, or policy decision-making — the engine owns all of that (ADR-006).

## The connection contract (identical to agent-runtime's, pre-committed)

1. **Service identity:** authenticates to the engine as a service (L3 token / agent identity); its own staff surface, if any, uses engine L1 sessions.
2. **Metering:** every token/request emits spend events to the engine ingest with `product_tag: inference` — engine quotas (`platform>tenant>product>project>surface>end_user`) and ledgers (per org × product) bill it.
3. **Policy/config:** engine-published model catalog entries, rate/quota profiles, and safety floor apply; the service enforces, the engine decides.
4. **Registration:** manifest (`faces: {runtime: true, consumer: false}` or as decided at trigger), entitlement codes (`inference-*` plans), summary provider (card: requests/s, latency, GPU utilization, cost) — the console renders it like any product.

## Pre-registered phases (all `[ ]` until triggered — opening requires an ADR-002 register amendment)

- [ ] N-0 — ADR: register `inference` as a product (plans, pricing model, regions)
- [ ] N-1 — Service skeleton (own deployment, own repo/namespace), engine ingest + identity integration
- [ ] N-2 — Manifest + entitlements + card live on `/console/home`
- [ ] N-3 — Model endpoints behind engine quotas; canary/gradual rollout; SLOs into the engine observability feed
- [ ] N-4 — Graduation criteria reviewed (GPU fleet sizing vs engine modules — ADR-006 D4)

**What this placeholder prevents:** an inference service that grows its own user table, its own billing, or its own policy brain — the exact "old project that tries to do many things" failure this architecture retired.
