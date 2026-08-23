# ADR-006 — Engine Scope: Core Logic Only; Capability Deployments Connect to It

**Status:** Accepted · **Date:** 2026-08-23 · **Decided by:** owner ("the current AI studio is our old project and tries to do many things; the engine only contains its core logic… in future we might have the inference deployment — its own separate deployment, connected to the engine; the engine handles users, billing and the rest; it only provides inference").
**Supersedes:** ADR-005's M7/M8 "port the runtime into the engine" framing and its D5 "hybrid fallback" framing — **the two-deployable shape is now the design, not the fallback.** Amends ADR-003's "one deployable" clause as noted in D3.

## D1 — The engine is the core, and only the core

The engine (TypeScript/NestJS, ADR-005) contains **core logic**: identity & accounts, organizations/entitlements, console/control plane, corporate module, metering & billing ledgers, contracts, governance/policy decision-making, audit. It is the **brain and the merchant** — it owns every user, every dollar, every policy decision.

## D2 — The capability-deployment pattern (the shape of everything that isn't core)

A capability deployment is a **separate deployable** that provides exactly one capability (inference; agent runtime; future heavy workloads) and **nothing that the engine owns**. The connection contract, always the same four things:

1. **Identity:** it authenticates to the engine as a service (L3 token / agent identity); it never stores users, passwords, or billing.
2. **Metering:** every unit of work emits spend events to the engine's metering plane with its product tag — the engine bills.
3. **Policy/config:** it subscribes to engine-published policy sets, guardrail profiles, and quotas — the engine decides, the capability enforces.
4. **Registration:** it appears in the engine's manifest registry (faces/entitlement codes/summary provider) — the console renders it like any product.

Own scaling, own release cadence, own technology choice. The engine never reaches into a capability deployment's internals; a capability deployment never grows a second brain.

## D3 — The old studio runtime is the FIRST capability deployment ("agent-runtime")

`products/neryva_agent_studio/backend` (the old project that "tried to do many things") keeps serving `/v1` and `/surfaces` — its durable value: session engine, threads, LLM gateway, guardrail enforcement, RAG. What it must **stop owning** moves to the engine over a phased handover (its ledger: `agent-runtime`): keys/token authority → engine; metering → engine pipeline; policy/config → engine-published; operator identity → engine OP. Its superseded subsystems (own quota plane, own identity) become thin clients, then are deleted. **Connect, don't port** — a TS rebuild of the runtime is optional and trigger-gated, never required. (This amends ADR-003's single-deployable clause: the engine is one deployable; capability deployments are its satellites — the module-boundary discipline is unchanged and now also runs over the wire.)

## D4 — Inference (future) is the second instance of the pattern

A future inference service: its own deployment (GPU scheduling, model serving — its own concern entirely), connected by the D2 contract (service identity, metering with tag `inference`, engine-published quotas, manifest + entitlements). Trigger-gated; its ledger exists as a placeholder so the pattern is pre-registered. Products whose execution outgrows the engine (e.g., the deployment product's worker fleet) may graduate to capability deployments via the same contract — an ADR-level act.

## Consequences

- The engine stays small and clean — core only — exactly as the owner directed; the multi-month runtime port is **eliminated** from the plan.
- One identity plane, one metering plane, one policy source remain true across engine + satellites (the invariants survive; enforcement extends over the wire).
- The strangler migration simplifies: net-new TS modules ship as planned (M1–M6); M7 becomes the agent-runtime handover phases; M8 (Python retirement) is re-scoped to "retire the *superseded subsystems* of the runtime," not the runtime itself.
- Ledgers: one file per namespace in `engine/docs/ledger/` — engine-core namespaces and capability deployments alike — the single progress tracker for end-to-end implementation.
