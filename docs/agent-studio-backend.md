# The Agent Studio Backend — Complete Verified Reference & Reimplementation Scope

**Date:** 2026-08-23 · **Method:** every claim below was read from the actual source on this date (module docstrings + line counts, file-anchored). No recollection, no invention.
**Serves:** [ADR-007](architecture/decisions/ADR-007-legacy-backends-references.md) — this backend is **reimplemented from scratch in NestJS as a standalone capability service**. The Python codebase is the **behavioral specification**, never the foundation. **Zero Python code gets ported.**

---

## 1. What this file prevents (read first)

Three confusions, killed here:
1. **"The engine contains guardrails/LLM logic."** No. The engine is core only (users, identity, orgs, billing, console, metering — ADR-006). The **guardrail stack, the LLM gateway, the session engine, and everything in §3 are the Agent Studio backend's OWN core logic**, living in its own standalone deployment.
2. **"We'll port/adapt the Python backend."** No. From-scratch NestJS implementation; the Python service's *behavior* (and its test suite as acceptance tests) is the spec.
3. **"neryva_backend (Express) gets absorbed/port-duplicated."** No. Its duties are **rebuilt from scratch** in the engine's corporate module (ADR-007 D3); the Express code is reference only.

## 2. What it is, in numbers (verified)

**221 Python files, 47,370 lines**, in `products/neryva_agent_studio/backend/app/`: `api/` 23 files (8,752L) · `application/` 47 (8,025L) · `infrastructure/` 35 (10,196L) · `modules/` 43 (6,085L) · `adapters/` 20 (3,966L) · `gateway/` 12 (3,467L) · `worker/` 7 (2,216L) · `session/` 6 (1,283L) · `governance/` 11 (1,432L) · `context/` 4 (616L) · `domain/` 8 (550L) · `settings/` 3 (340L) · plus 16 Alembic migrations (0001–0016).

## 3. The core logic it OWNS (the reimplementation scope — every item file-verified)

### 3.1 The LLM Gateway — `app/gateway/` (12 files, 3,467L)
- **`service.py` (1,078L)** — "the gateway is the ONLY component that talks to providers"; orchestration/routes construct `GatewayRequest`, consume `GatewayResult`/`GatewayStreamEvent`, and never see provider SDKs, wire formats, or keys.
- **`router.py` (208L)** — decisions under ~30ms from per-deployment health (Redis cooldown state), price cards, and EWMA latency; per-tenant strategies **cost / latency / quality-pinned / pinned**; tiered routing (simple→cheap, complex→capable) under tenant policy; pure, in-process, no I/O.
- **`cooldown.py` (325L)** — per-deployment cooldowns in Redis shared across replicas (explicitly modeled on LiteLLM's `cooldown_cache` design: `allowed_fails` within `cooldown_time`).
- **`fallback.py` (185L)** — three fallback classes: `general` (timeout/5xx/connection → next healthy → tenant fallbacks → family default), `content_policy` (provider refusal), plus a third class; ordered target lists.
- **`admission.py` (181L)** — concurrent in-flight generation bounds per tenant + platform (asyncio semaphores + Redis counter with TTL lease so crashed workers' slots expire); excess → 429 with `Retry-After`.
- **`quota.py` (316L)** — USD reservation/reconciliation over the hierarchy `platform > tenant > surface > end_user` via Redis Lua; reserve estimated max before routing, reconcile after; soft alert at 80%, hard block at 100%.
- **`cache.py` (457L)** — two per-tenant cache layers (exact-match keyed on canonical request + prompt version; semantic), every key tenant-scoped.
- **`ledger.py` (121L)** — append-only USD cost capture, persisted asynchronously via a `cost_ledger.write` queue job (never blocks the request path).
- **`catalog.py` (166L)** — the single source of model facts (context windows, price cards) consumed by the context layer.
- **`anomaly.py` (237L)** — opt-in per tenant: spend-spike detection (1h > N× trailing 7-day p95) and daily-budget burn-rate alerts (50/75/90/100%), emitted on the webhook contract.

### 3.2 Provider adapters — `app/adapters/llm/` (5 files)
- **`litellm_adapter.py` (499L)** — **the production provider path**: delegates wire translation (streaming, tool calls, structured output, provider quirks) to **LiteLLM** behind a thin translation layer. *(For the NestJS build: the equivalent provider-unification choice — e.g. a LiteLLM proxy sidecar or a TS provider gateway — is a build-time decision recorded in its ledger; the *pattern* is mandated: one adapter boundary, zero provider branches outside it.)*
- **`provider.py` (790L)** — the stable public surface + `create_llm_adapter` factory; native per-SDK adapters exist as the deprecated fallback.
- **`provider_registry.py` (543L)** — single source of truth for every provider: identity, model strings, capabilities, regions, health probes, auth quirks; nothing hard-codes provider strings.

### 3.3 The guardrail stack — `app/modules/guardrails/` (15 files) + validation + DLP
- **`orchestrator.py` (569L)** — the layered pipeline: **REGEX_FASTPATH → CLASSIFIER → JAILBREAK_SCAN → NEMO_RAILS → LLAMA_GUARD**, parallel/sequential modes, per-layer circuit breakers, **shadow mode** (evaluate-but-don't-enforce layers with separate metrics/evidence), evidence emission per decision.
- Layers: `regex_fastpath.py` (161L), `classifier.py` (267L), `jailbreak.py` (120L), `nemo_rails.py` (164L), `llama_guard.py` (168L — Llama Guard 4, optional, **off by default**), `guardrails_ai.py` (250L), `spotlighting.py` (62L).
- **`pii_engine.py` (153L)** + **`adapters/dlp/presidio.py` (154L)** (Microsoft Presidio, lazy import) + **`adapters/dlp/cloud.py` (268L)** (Google Cloud DLP / AWS Macie / Azure Purview second layer).
- **`app/application/validation/streaming.py` (119L)** — **rolling-window output moderation**: deltas are held until a window accumulates, validated (PII + policy) asynchronously, then released — the stream is never emitted verbatim.
- **`app/application/validation/validator.py` (169L)** — Guardrails-AI + schema output validation.

### 3.4 The session engine — `app/session/` (6 files, 1,283L)
- **`coordinator.py` (284L)** — per-thread serialization: at most one in-flight generation per thread; waiters queue in order (local asyncio lock + cross-process Redis lock with TTL lease + renewal; holder death expires the lease).
- **`service.py` (299L)** — thread mutations are **strictly append-only** (regenerate/edit append with `parent_message_id`; nothing mutated in place; both attempts stay visible).
- **`hot_tier.py` (188L)** — Redis thread-tail cache (last N turns + running summary block; reads promote TTL; stable summary position).
- **`limits.py` (225L)** — end-user abuse limits (rate token-bucket, concurrent-session lease counter, spend cap; fail-open on Redis failure with alerts).
- **`tokens.py` (286L)** — end-user session tokens (L4): Fernet-encrypted opaque bearers bound to (tenant, end_user, surface, device, expiry, scopes); the durable row is the revocation truth.
- **`app/infrastructure/db/threads.py` (1,122L)** — the durable append-only thread log (atomic appends, seq under a thread-row lock).

### 3.5 The context stack — `app/context/` + compaction/memory/retrieval
- **`context/assembler.py` (365L)** — "the single component that constructs the LLM prompt… nothing else in the codebase builds provider messages"; block order: system → summary → memory → recent tail; **`estimator.py` (86L)** — chars-per-token budget math; **`context/metrics.py` (117L)** — prompt-cache hit-rate with per-provider normalization.
- **Compaction** (`application/compaction/`): **`service.py` (659L)** — rolls a thread's head into a structured summary block (objective/key facts/decisions/pending/next), token-bounded live tail, **atomic snapshot→swap**; `breaker.py` (100L) — pause after N consecutive failures; `refresh.py` (152L) — background refresh so triggered compaction is an instant swap; `eval.py` (635L) — round-trip fact-retention evals.
- **Memory** (`application/memory/service.py`, 280L) — durable structured facts extracted from closed turns, PII-filtered twice (input + output), per tenant/end-user; store in `infrastructure/db/memory.py`.
- **Retrieval** (`application/retrieval/`): shipped single-stage vector path + **`hybrid.py` (208L)** — pure-Python Okapi BM25 + vector fusion; **`rerankers.py` (128L)** — cross-encoder reranking; `metrics.py` — ranked-retrieval metrics gating hybrid enablement. Vector stores via `adapters/vectorstore/provider.py` (440L — pgvector/Qdrant unified interface); embeddings via `application/ingestion/embeddings.py` (SentenceTransformer, lazy, fail-loud).

### 3.6 Orchestration, tools, escalation, handoff
- **`application/orchestration/service.py` (1,551L)** — the agent decision loop on **LangGraph**: propose → evaluate → select → execute (the P2-9 runtime loop: screen → retrieve → generate → authorize → execute → verify → reply/escalate). *(NestJS build: the loop semantics are the spec; the graph library choice is free.)*
- **Tools**: `application/tools/registry.py` (189L — OpenAI-function-format schemas, executors by name) + `factory.py` (95L — per-request registry from tenant rows) + `sources.py`; **`adapters/tools/mcp.py` (569L)** — MCP client over the official SDK (multiple transports).
- **Escalation** (`modules/escalation/service.py`, 355L) and **handoff** (`application/handoff/service.py`, 252L) → **ticketing adapters** (`adapters/ticketing/`: Zendesk, Jira, ServiceNow, generic-webhook; registry-built).

### 3.7 Governance enforcement — `app/governance/` (11 files, 1,432L)
**The engine decides; this service enforces** (ADR-006): `compiled.py` (199L — immutable ready-to-run `CompiledSurfaceConfig` per surface/version) · `toolgate.py` (115L — deterministic tool authorization: registry membership + policy, separate from verification) · `evidence.py` (223L — one validated evidence packet per policy decision, tenant+end-user scoped) · `rls.py` (137L — Postgres RLS, defense-in-depth) · `isolation.py` (82L — immutable `TenantContext` single-step resolution) · `compliance.py` (162L — EU-AI-Act posture: bot disclosure, content marking, Art. 73 incident hook) · `presets.py` (285L) · `promotion.py` (72L — config promotion gates: edit→validate→eval→canary) · `residency.py` (56L — region pinning) · `budgets.py` (90L — budget composition into gateway config). Policy *publishing* and simulation move to the engine ([`ledger/agent-runtime.md`](ledger/agent-runtime.md) A-4).

### 3.8 Infrastructure & workers — `app/infrastructure/` (35 files, 10,196L) + `app/worker/` (7 files, 2,216L)
Persistence: `db/models.py` (832L — 60+ ORM models, UUID-as-String(36) for SQLite/Postgres parity, JSONB on Postgres), `db/repositories.py` (2,535L), `db/replicas.py` (315L — read replicas, read-your-writes window, round-robin, primary fallback). Platform services: `cache/` (aiocache wrapper + tenant-runtime micro-cache), **`queue/manager.py` (438L — purpose-built Redis queue: priority tiers, scheduled execution, dead-letter, idempotency)**, `patterns/` (retry/tenacity, circuit-breaker/pybreaker, rate-limiter/limits, idempotency, batched last-active writes), `keys/` (Fernet envelope for provider credentials, KMS-ready), `observability/` (Prometheus metrics incl. TTFT, SLOs-as-code, OTel tracing with PII-safe spans, SIEM export: Splunk HC/…), `storage/`, `stream/` (server-side chunk buffer + overflow spillover).
Workers: `handlers.py` (636L — one handler per job type; raise-to-retry semantics) · `quality_monitor.py` (563L — LLM-as-judge on sampled traffic, drift + auto-escalation) · `canary_monitor.py` (287L — config-canary monitoring + auto-rollback) · `eval_extractor.py` (158L — PII-redacted trace→eval-corpus extraction) · `retention.py` (395L) + a JSON job schedule.

### 3.9 The API surfaces — `app/api/routes/` (19 files, 8,752L)
`conversations.py` (**3,612L** — chat/SSE endpoints, rolling moderation, streaming) · `openai_compat.py` (474L — the OpenAI-compatible public API, L2 keys only) · `harness.py` (818L — operator workbench) · `policies.py` (400L — policy sets, MFA-gated publish, simulation) · `operator_auth.py` (385L — operator sessions; **superseded by engine identity**) · `threads.py` (363L) · `usage.py` (277L) · `tools.py` (276L) · `evals.py` (227L) · `console.py` (213L) · `operations.py` (209L) · `sessions.py`, `surfaces.py`, `webhooks.py`, `prompts.py`, `model_catalog.py`, `traces.py` · plus `api/dependencies/auth.py` (L2 keys + operator sessions + MFA proofs — the enforcement spec for the kernel guards).

## 4. What it does NOT own (the engine's — never reimplement here)

Accounts/credentials/login (**engine identity**) · orgs, memberships, invites, projects, entitlements (**engine organizations**) · billing ledgers, invoices, usage rollup (**engine metering**) · console home/manifests/cards (**engine console**) · neryva.com forms/content (**engine corporate**) · API-key issuance (**engine**; this service validates with a cache — [`ledger/agent-runtime.md`](ledger/agent-runtime.md) A-1).

## 5. The connection contract (ADR-006 D2 — identical for every satellite)

(1) Service identity to the engine (L3); (2) every unit of work meters to the engine with `product_tag: agent_studio`; (3) engine-published policy sets/guardrail profiles/quotas are authoritative — this service enforces; (4) registered in the engine manifest registry. It serves `/v1/**`, `/surfaces/**`, and its internal job plane.

## 6. Reimplementation rules (ADR-007)

1. **Fresh NestJS codebase** (its own service, e.g. `products/agent-studio/backend-ts/`), standalone deployment, own release cadence.
2. **Behavior spec = this file + the Python test suite** (ported as acceptance tests) + the pinned contract for `/v1`.
3. Every §3 area gets a **TS-native implementation** — same semantics, TS-idiomatic tools (Nest modules; BullMQ for the queue; Prisma for persistence; the provider-unification choice for §3.2 decided in its ledger).
4. The Python service stays in production until per-namespace parity flips (contract snapshot + acceptance tests + shadow run); then it is retired with honor.
5. **No hybrid merging into the engine, ever** — if a piece feels engine-worthy, that's an ADR (Rule of Two, partitioning).
