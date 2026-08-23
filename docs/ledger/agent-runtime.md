# Ledger — agent-runtime (capability deployment #1 — the old studio backend)

**Namespace served:** `/v1/**` (OpenAI-compatible), `/surfaces/**` (widget), `/internal/**` (its jobs) · **Deployment:** `products/neryva_agent_studio/backend` (Python) — separate deployable, **connects to the engine, never merges** · **Binding:** [ADR-006 D3](../architecture/decisions/ADR-006-engine-core-capabilities.md).
**Current state (verified):** fully functional runtime (session engine, threads, gateway with fallbacks/cooldowns, guardrails + shadow mode, governance/RLS/audit, spend pipeline) — but it still owns things the engine must own (keys, metering, policy publishing, operator identity). **103-file implementation batch still uncommitted — E0/git recovery precedes everything.**

## The connection contract (ADR-006 D2 — what "done" means for this satellite)
1. Service identity: runtime authenticates to the engine (L3); 2. Metering: all spend pushes to the engine (tag `agent_studio`); 3. Policy/config: engine-published sets are authoritative; 4. Registered in the engine manifest registry (card on `/console/home`).

## Phases

### A-0 — Stabilize the satellite
- [ ] E0: commit the 103-file batch; git/tree recovery per [`reorganization-guide`](../architecture/reorganization-guide.md); proxy path rules (`/v1`, `/surfaces` → runtime; everything else → engine as it ships)
- **Gate:** runtime green on its own suite; proxy routing verified

### A-1 — Key/token authority → engine
- [ ] Engine issues/revokes `nrv_live_` keys (console UI → organizations O-1 alterations on `api_keys`); runtime validates via engine API with a short-TTL cache; break-glass: runtime falls back to read-only local table during engine outage
- **Gate:** key created in console authorizes `/v1` on the runtime; revocation propagates ≤ cache TTL

### A-2 — Identity cutover on the runtime
- [ ] Runtime's operator endpoints accept engine L1 tokens (JWKS verify); its `operator_sessions` superseded by engine sessions; end-user L4 tokens gain `account_id` link (engine issues account links)
- **Gate:** console (web app `/studio` area) drives the runtime with one engine login

### A-3 — Metering handover
- [ ] Runtime emits spend to the engine ingest ([`billing-metering`](billing-metering.md) B-1) — dual-write window → engine-only; quota enforcement authority moves to engine levels (B-1 quotas)
- **Gate:** reconciliation clean (engine totals = runtime totals during dual-write); cutover

### A-4 — Policy/config publishing → engine
- [ ] Policy sets, guardrail profiles (incl. shadow-mode config), model catalog publish from the engine; runtime subscribes (versioned pull + push notification); runtime's local editing routes freeze (read-only)
- **Gate:** engine-published policy change visible in runtime enforcement within one refresh cycle; audit chain unbroken across the wire

### A-5 — Superseded-subsystem retirement (ADR-006 D3: only the superseded parts)
- [ ] Runtime's own quota plane, key management UI/API, operator auth, config editing → thin clients → deleted; runtime keeps: session engine, threads, gateway, guardrail enforcement, RAG
- **Gate:** 410s two releases on superseded routes; ownership map updated; runtime suite green

### A-6 — From-scratch NestJS reimplementation (DECIDED — [ADR-007](../architecture/decisions/ADR-007-legacy-backends-references.md); the main build track, not an option)
- [ ] Fresh NestJS service (standalone capability deployment) implementing the **verified scope** in [`../agent-studio-backend.md`](../agent-studio-backend.md): gateway, provider adapter (LiteLLM-pattern), guardrail stack, session engine, context stack, orchestration loop, tools/MCP, escalation/handoff, governance enforcement, workers, `/v1` + `/surfaces` APIs — zero Python code ported; the Python suite ports as acceptance tests
- [ ] Per-namespace parity flips (contract snapshot + acceptance + shadow): `/v1` first, then `/surfaces`
- [ ] Python retires when the last namespace flips; its behavior-spec duty ends and the reference file freezes
- **Gate:** each flip: shadow zero-diff + acceptance green + load parity; final flip retires the Python deployment
