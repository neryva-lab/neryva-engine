# Ledger — agent-runtime (capability deployment #1 — the old studio backend)

**Namespace served:** `/v1/**` (OpenAI-compatible), `/surfaces/**` (widget), `/internal/**` (its jobs) · **Deployment:** `products/neryva_agent_studio/backend` (Python) — separate deployable, **connects to the engine, never merges** · **Binding:** [ADR-006 D3](../architecture/decisions/ADR-006-engine-core-capabilities.md).
**Current state (verified):** fully functional runtime (session engine, threads, gateway with fallbacks/cooldowns, guardrails + shadow mode, governance/RLS/audit, spend pipeline) — but it still owns things the engine must own (keys, metering, policy publishing, operator identity). The prior 103-file batch is committed (studio `1851514`, tree clean); reorg Stage 1 + proxy bring-up remain (A-0). **Runtime engine-client v1 landed 2026-08-24**: heartbeat sender + key-validation cache (A-1 runtime side) + L1 console-token acceptance (A-2 dual-run) — `backend/app/engine_client/`, standalone when `ENGINE_BASE_URL` unset.

## The connection contract (ADR-006 D2 — what "done" means for this satellite)
1. Service identity: runtime authenticates to the engine (L3); 2. Metering: all spend pushes to the engine (tag `agent_studio`); 3. Policy/config: engine-published sets are authoritative; 4. Registered in the engine manifest registry (card on `/console/home`).

## Phases

### A-0 — Stabilize the satellite
- [ ] E0: commit the 103-file batch; git/tree recovery per [`reorganization-guide`](../architecture/reorganization-guide.md); proxy path rules (`/v1`, `/surfaces` → runtime; everything else → engine as it ships)
- **Gate:** runtime green on its own suite; proxy routing verified

### A-1 — Key/token authority → engine
- [~] Engine issues/revokes `nrv_live_` keys (console UI → organizations O-1 alterations on `api_keys`); runtime validates via engine API with a short-TTL cache; break-glass: runtime falls back to read-only local table during engine outage
- **Gate:** key created in console authorizes `/v1` on the runtime; revocation propagates ≤ cache TTL
- **Runtime side implemented** (2026-08-24, `backend/app/engine_client` + `api/dependencies/auth.py`): `POST /internal/keys/validate` with per-answer TTL cache (15s positive/5s negative — the propagation bound), engine answers authoritative over the local table, `EngineUnavailableError` → break-glass local read. 13-test suite green (`backend/tests/test_engine_client.py`). Gate pending a live engine bring-up.

### A-2 — Identity cutover on the runtime
- [~] Runtime's operator endpoints accept engine L1 tokens (JWKS verify); its `operator_sessions` superseded by engine sessions; end-user L4 tokens gain `account_id` link (engine issues account links)
- **Gate:** console (web app `/studio` area) drives the runtime with one engine login
- **L1 acceptance implemented** (2026-08-24): `Authorization: Bearer <RS256 JWT>` verified offline via the engine OP's JWKS (iss/aud/exp + svc-sub rejection, stale-keys-served-on-outage) and mapped to an operator principal — dual-run alongside `nrv_ops_` sessions, exactly as the engine guard's comment prescribes. **Remaining for the checkbox:** end-user L4 `account_id` link; `operator_sessions` retirement (A-5).

### A-3 — Metering handover
- [ ] Runtime emits spend to the engine ingest ([`billing-metering`](billing-metering.md) B-1) — dual-write window → engine-only; quota enforcement authority moves to engine levels (B-1 quotas)
- **Gate:** reconciliation clean (engine totals = runtime totals during dual-write); cutover

### A-4 — Policy/config publishing → engine
- [~] Policy sets, guardrail profiles (incl. shadow-mode config), model catalog publish from the engine; runtime subscribes (versioned pull + push notification); runtime's local editing routes freeze (read-only)
- **Gate:** engine-published policy change visible in runtime enforcement within one refresh cycle; audit chain unbroken across the wire
- **Engine side implemented** (2026-08-24, `modules/config-publish` v2 + eng-0016): the full editor — draft→validate→publish→rollback with strict per-scope payload schemas mirroring the runtime's own consumption shapes (policy rules incl. kind/action enums, the 7 guardrail rails + thresholds + `shadow_mode`, the budgets.py quota ladder, model catalog with unique pairs and self-referencing defaults); invalid configs cannot publish. Satellites consume `bootstrap` (one-shot cold sync + cursors), `latest` (ETag/payload-digest → 304), versioned `since` catch-up (paginated, never silently truncated), and the ACK ledger. Delivery observability (per-satellite ACK state + registry liveness), re-notify, webhook push (`config.published`), and retention (versions + acked notifications) are engine-side; unacked-drift incidents live in the satellites sweeper (`config_drift`). **Remaining for the checkbox:** the RUNTIME side — subscribe to the pull zone, apply versions, freeze its local editing routes read-only.

### A-5 — Superseded-subsystem retirement (ADR-006 D3: only the superseded parts)
- [ ] Runtime's own quota plane, key management UI/API, operator auth, config editing → thin clients → deleted; runtime keeps: session engine, threads, gateway, guardrail enforcement, RAG
- **Gate:** 410s two releases on superseded routes; ownership map updated; runtime suite green

### A-6 — From-scratch NestJS reimplementation (DECIDED — [ADR-007](../architecture/decisions/ADR-007-legacy-backends-references.md); the main build track, not an option)
- [ ] Fresh NestJS service (standalone capability deployment) implementing the **verified scope** in [`../agent-studio-backend.md`](../agent-studio-backend.md): gateway, provider adapter (LiteLLM-pattern), guardrail stack, session engine, context stack, orchestration loop, tools/MCP, escalation/handoff, governance enforcement, workers, `/v1` + `/surfaces` APIs — zero Python code ported; the Python suite ports as acceptance tests
- [ ] Per-namespace parity flips (contract snapshot + acceptance + shadow): `/v1` first, then `/surfaces`
- [ ] Python retires when the last namespace flips; its behavior-spec duty ends and the reference file freezes
- **Gate:** each flip: shadow zero-diff + acceptance green + load parity; final flip retires the Python deployment
