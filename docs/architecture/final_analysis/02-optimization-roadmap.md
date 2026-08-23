# Optimization Roadmap

**Focus:** latency on the conversation hot path, cost per turn, and throughput under load.
**Rule:** no optimization lands without a before/after number. Baseline first (OPT-0), then measure every item.
**All file paths are real and were read during this analysis (2026-08-23).**

> **Status update (2026-08-23):** OPT-1, OPT-2, OPT-4, and OPT-8 (spend/usage/chargeback scope) are **implemented** — details in `01-health-and-blockers.md` §5. OPT-0 baseline, OPT-3, OPT-5, OPT-6, OPT-7, OPT-9, OPT-10, and the remaining OPT-8 scope (eval/audit reads — deliberately kept on the primary for hash-chain correctness) are still open.

---

## OPT-0 — Baseline before touching anything

The k6 scripts already exist (`ops/loadtest/`, thresholds p95 < 1.5 s, error < 1 %) but there is no recorded baseline run for the current tree. Before any change:

1. Run `ops/loadtest` against a staging compose stack; record p50/p95/p99 for `POST /conversations` and `/conversations/stream`, plus DB query count per request (enable SQLAlchemy echo on one request or use the OTel span counts).
2. Record the per-request DB roundtrip count for one warm conversation turn (see OPT-1 — it is the number we want to shrink).
3. Snapshot `neryva_*` Prometheus metrics (routing latency, cache hit rates, guardrail layer latencies) — they are already instrumented (`infrastructure/observability/metrics.py`).

**Acceptance:** a `docs/final_analysis/baselines/` note (or run sheet) with the numbers above, dated.

---

## OPT-1 — Cut per-request DB roundtrips on the conversation hot path (highest impact)

**Where:** `backend/app/api/routes/conversations.py` — `process_conversation` (line 638) and `stream_conversation` (line 1354).

Today one non-streaming turn performs, **sequentially**, at minimum:

1. `TenantRepository.get_by_slug` (~line 675)
2. `_load_effective_tenant_config` → tenant row **plus** latest published `tenant_config_versions` (~line 683)
3. `_load_or_create_policy_set` (~line 720)
4. `ConversationRepository.get_or_create` (~line 723)
5. `_resolve_request_surface` (~line 744)
6. `ThreadRepository.get_or_create_for_conversation` via `_bind_thread` (~line 745)
7. history/summary reads (`_load_history_turns`, `_load_thread_summary`, ~lines 892–897)

Items 1–3 and 5 are **stable between config publishes** and are pure read overhead on every turn. The invalidation infrastructure already exists (config publish invalidates the in-process service cache; the gateway cache layer has `cache_invalidation_log` from P3-7).

**Work:**
- Introduce a short-TTL (30–60 s) Redis-backed (in-process L1, Redis L2) cache for: tenant-by-slug → tenant row, effective tenant config (tenant + published version), published policy set, and surface resolution. Invalidate on publish/promote/rollback events — the same events that already fire.
- Keep the 404-on-unknown-slug semantics: a miss on the slug cache falls through to the DB once.
- Do **not** cache conversation/thread binding (write path).

**Acceptance:** warm-turn DB roundtrips for config/policy/surface drop from 5–6 to 0 (cache hit); publish → invalidation → next read fresh, proven by a test; k6 p95 improves vs. OPT-0 baseline.

## OPT-2 — Parallelize independent awaits in the request path (free latency)

**Where:** same two endpoints.

Three groups are independent of each other and currently sequential:

- `_load_history_turns` + `_load_thread_summary` (~lines 892–897) → `asyncio.gather`.
- `_build_governance_wiring` (~line 916) + `_build_tool_registry` (~line 924) + `_build_prompt_resolver` (~line 942) → `asyncio.gather`.
- Langfuse trace creation (~line 698) can overlap the rate-limit acquire.

The codebase already uses `asyncio.gather` in the harness compare route (`api/routes/harness.py:801`) and tool fan-out (`application/orchestration/service.py:613`), so this matches existing idiom.

**Acceptance:** no behavioral change in tests; measured per-turn latency contribution of these sections drops (span timings).

## OPT-3 — Guardrail pipeline concurrency and early-exit audit

**Where:** `backend/app/modules/guardrails/orchestrator.py` (439+ lines), `application/validation/streaming.py`.

The input pipeline is deliberately ordered deterministic→probabilistic (Arch §2.7) — do not reorder it. But verify:

1. Layers that **can** run concurrently after the regex fastpath (classifier + jailbreak) are gathered, not sequential.
2. Presidio analyzer is warm per-process (it loads NLP models; confirm lazy single init, not per-request).
3. The streaming moderation window (`STREAM_MODERATION_WINDOW_CHARS`, default 400) never validates the same bytes twice.

**Acceptance:** guardrail stage p95 from the existing per-layer SLO metrics; a test pinning "classifier and jailbreak issued concurrently" if we make that change.

## OPT-4 — Routing latency gate (< 30 ms) enforced in CI

**Where:** `backend/app/gateway/service.py`, `gateway/catalog.py`.

Arch §10 requires routing decisions < 30 ms. The router is built, but nothing in CI fails if it regresses. Add:

1. A micro-benchmark test (pytest marker, runs in the CI backend job): build a catalog of ~200 models, run N=10k route decisions on a warmed router, assert p99 < 30 ms.
2. The routing-decision metric already exists — add a Prometheus record rule + alert (`ops/monitoring/alert_rules.yml`) at p95 > 25 ms for 10 min.

**Acceptance:** CI red on routing regression; alert visible in the rules file.

## OPT-5 — Turn on the retrieval upgrades the backend already shipped (quality → cost optimization)

**Where:** `application/retrieval/hybrid.py`, `application/retrieval/rerankers.py`, migration `0011_phase9_hybrid_fts.py`; flags `ENABLE_HYBRID_RETRIEVAL`, `ENABLE_CROSS_ENCODER` (both default **False**, correctly gated pending recall evals — see ledger §14).

The plan recorded in the ledger: run recall evals (P6-6 harness, datasets under `evals/`), and if Recall@k / MRR improves without unacceptable latency:

1. Enable hybrid retrieval per-tenant (flag or tenant feature) for pilot tenants; measure retrieval latency delta (BM25 via Postgres FTS adds a query; consider a GIN-covered covering index and `LIMIT` pushdown).
2. Enable cross-encoder rerank **top-50 → top-5** only where latency budget allows (it is the most expensive step; keep it off for latency-sensitive surfaces via per-surface config).
3. Better retrieval ⇒ fewer "retry/re-ask" turns and fewer escalated handoffs — track handoff-rate delta as the cost metric.

**Acceptance:** eval report with before/after Recall@k, MRR, p95 retrieval latency; per-tenant rollout flags; handoff-rate comparison over a fixed window.

## OPT-6 — Semantic/exact cache: measure, then tune

**Where:** gateway cache layer (P3-7), `infrastructure/cache/manager.py`.

1. Surface per-tenant **cache hit rate** in the admin Usage/Billing view (metric exists; UI does not show it — also listed in `03-missing-features.md`).
2. Tune similarity threshold + TTL per surface (FAQ-ish surfaces tolerate aggressive thresholds; complex reasoning surfaces should bypass).
3. Confirm invalidation hooks fire on KB reindex and config publish for every cache layer (tests exist — keep them pinned).

**Acceptance:** hit-rate visible in UI; documented per-surface defaults; cost-per-resolved-conversation trend improving.

## OPT-7 — Token estimation: replace the 4-chars/token heuristic for budget-critical paths

**Where:** `backend/app/context/estimator.py` (4 chars/token default with per-model overrides, by design per P2-1/P2-2).

The heuristic over-estimates for code/mixed content and under-estimates for some languages, which wastes context budget (over-trimming history) or triggers avoidable compaction. Next step:

1. Use the P2-10 estimation-error eval to quantify current error per provider.
2. Introduce an optional tokenizer-backed estimator (per-provider encoding, lazy-loaded) behind a flag; keep the heuristic as fallback.
3. Recalibrate `CONTEXT_OUTPUT_RESERVE_TOKENS` once real counts exist.

**Acceptance:** estimation error report (current vs tokenizer-backed); assembler budget decisions change measurably; no regression in compaction trigger tests.

## OPT-8 — Offload more read paths to replicas

**Where:** `infrastructure/db/replicas.py` (ReplicaRouter, P8-3 — already routes history reads), repositories used by admin/ops surfaces.

Move these to replica sessions (they never need read-your-writes):

- Traces explorer (`api/routes/traces.py` → `SpendEventRepository.list_filtered`)
- Usage aggregates (`api/routes/usage.py` → `SpendEventRepository.aggregate` — the chargeback CSV is a full-table scan shape; consider a materialized rollup)
- Evals read paths (`api/routes/evals.py`)
- Stale-thread compaction sweep queries (`list_threads_stale_for_compaction`)

Also: schedule the L2 item already designed — cross-process read-your-writes marker in Redis (documented in `docs/implementation/read-replicas.md` as the L2 swap).

**Acceptance:** primary DB QPS drop under an admin-generated load (Dashboard + Traces browsing); no correctness regressions in RYW tests; chargeback endpoint p95 bounded.

## OPT-9 — Split `conversations.py` (maintainability that unlocks optimization)

**Where:** `backend/app/api/routes/conversations.py` — now **3,604 lines** (the ledger's P0-1 audit recorded 1,367; the file has since absorbed tenant CRUD, compliance, api-keys, escalations, HITL pause/resume, and the streaming endpoint).

This was a recorded shape conflict (§2 of the ledger: "REPLACE (shape conflict) — split into session/context/gateway modules") that P1-10 resolved internally but the file kept growing. Every optimization in OPT-1/OPT-2 gets harder to review inside one module. Split by router concern:

- `conversations.py` (the two chat endpoints only)
- `tenants.py` (tenant CRUD + config + onboarding + compliance) — partially exists in `routes/tenants.py`; finish the move
- `api_keys.py`, `escalations.py`, `hitl.py`

Additive route moves only; the OpenAPI pin test (`test_contracts.py`) guards the contract.

**Acceptance:** no file > ~800 lines in `api/routes/`; OpenAPI unchanged (test_contracts green); import graph acyclic.

## OPT-10 — Frontend/widget performance pass

**Where:** `frontend/` (React 19 + TanStack Query + Vite), `widget/`.

1. Verify Vite production build does code-splitting per route (check `rollupOptions.output.manualChunks` / bundle report; a single-vendor-chunk is fine, a single app chunk is not).
2. Traces/Audit/Evals tables: confirm pagination is server-side (backend has cursor pagination) and lists are virtualized if rows can exceed ~100.
3. TanStack Query: audit `refetchInterval` usage on Dashboard — replace fixed polling with focused refetch on mutation where practical.
4. Widget: SSE transport already reconnects with backoff; confirm no re-render storm on token stream (batch renders per animation frame in `state/messages.ts`).

**Acceptance:** Lighthouse/bundle report attached; no unbounded list rendering; dashboard network tab shows no refetch storm at idle.

---

## Explicitly deferred (with reasons)

- **Cross-process RYW in Redis** — L2 item, ship with the second API replica (OPT-8 references it).
- **Cross-encoder on all surfaces** — gated on OPT-5 eval results.
- **pgvectorscale / dedicated vector service** — per `stack.md` decision flow, only when the pgvector ceiling is hit; not yet measured.
- **Compaction summarizer model tuning** — cheap-model pinning and bounded output already ship (P2-3); revisit only if compaction-quality metrics degrade.
