# AI-Native Infrastructure Review — Principal Assessment, Verified Against Code (2026-09-17)

> Status: REVIEW (verified) → build phases in §8. Method: every claim below was checked against the engine source before being
> written. File:line references are the evidence. Where the assessment was right, the gap is specified to buildable precision.
> Where it was wrong, the existing mechanism is cited so we never build a duplicate. Engine-first; frontend follows (§9).
> Quality bar: no silent drops — §7 lists everything adjusted, deferred, or rejected with reasons.

## Verdict table (read this first)

| # | Assessment claim | Verified truth | Verdict |
|---|---|---|---|
| 1a | Embeddings have no tenancy contract | pgvector in-DB; `embeddings` carries `organization_id` + `model` (`knowledge/schema.ts:176-188`); org RLS posture throughout | COVERED — document, don't build |
| 1b | Embedding model upgrades break old versions | `documents.embedding_model` cursor + atomic per-doc `reembed.worker.ts` + `KnowledgePin.embedding_model` + `knowledge_config` in snapshot (`manifest-resolution.service.ts:56-73`) | COVERED in storage — NOT enforced at retrieval (the real gap) |
| 1c | Vector search mixes models during migration | Vector-leg SQL has **no `e.model` filter** (`retrieval.service.ts` ~231-241); worker keeps old rows until new rows land — by design | CONFIRMED BUG — fix first (§2) |
| 1d | No indexing readiness; publish must refuse | Doc state machine (`processing\|ready\|failed\|retired`) + degraded-pins publish gate exist | PARTIAL — embedding-*coverage* per model missing (§2) |
| 2a | Tool execution perimeter undefined | MCP transport (external gateway posture); effect classes READ_ONLY\|MUTATING\|DESTRUCTIVE (`tool-catalog.schema.ts:21`); approvals; single-attempt mutating retry; per-run execution caps; `tool` control-block denies authorize + credential reads | PARTIAL — execution env + egress + shadow mode missing (§3) |
| 3a | Budgets only post-run | `budget_policy` enforced at run scope (`mcp-authority.service.ts:1676-1682`: tool/model calls, total tokens, cost micros, wall clock); usage ledger (estimated+settled, idempotent, reconciled); quota reservations; burn-rate auto-pause with attribution | PARTIAL — intra-stream severing unconfirmed; cache economics missing (§4) |
| 4a | Episodic/semantic memory conflated | Separated: thread (history_limit) vs `memory_items` (org\|conversation\|assistant\|user scopes, approval-gated proposals, HNSW embeddings, `expiresAt` TTL, `deletedAt` targeted delete, `validFrom/invalidAt/supersedes` temporal validity, `retrieval_acl`) | WRONG — corrected; residual gaps specified (§5) |
| 5a | No observability / no OTEL | Exporter EXISTS (`src/tracing.ts`: OTLP/HTTP, env-gated, shutdown flush; metrics deliberately on Prometheus) — but **zero `startSpan` calls in `src`** | HALF-RIGHT — instrumentation layer missing (§6) |
| 5b | No shadow evals on model drift | No scheduled re-eval; `modelRef` pins provider/model + catalog entry hash (drift *detectable*, never *acted on*) | CONFIRMED GAP (§6) |
| 6.1 | Credentials need rotation/compromise states | Terminal revoke, `rotatedAt/rotatedBy`, vault `externalRef`, active-only reads, rotate-refuses-revoked, audited | COVERED — add incident semantics only (§7) |
| 6.2 | No version lineage beyond `rollback_of` | Confirmed: no parent link; fork-from-v1 → publish-as-v5 is untraceable | CONFIRMED GAP, small (§7) |
| 6.3 | Guardrails need logging (shadow) mode | Verdicts `allow\|flag\|block` (`moderation.ts:21`); no per-policy execution mode | CONFIRMED GAP (§7) |
| 6.4 | Degraded-knowledge bypass needs TTL + auto-suspend | Confirmed: audited bypass only, no TTL, no DEGRADED state, no alert | CONFIRMED GAP (§7) |

## 1. RAG & Vector Tenancy — what exists (do not rebuild)

- Tenancy: `embeddings {id, chunk_id→chunks cascade, organization_id, model, embedding vector}` with `ix_embeddings_org`; every
  knowledge table carries `organization_id` under the same ENABLE+FORCE RLS posture as assistants. Chunks → document_versions →
  documents chain preserves version identity; `retrieval_acl` (organization|private + scope_account_id) gates reads.
- Model evolution: org `knowledge_config.embedding_model` is the target; `documents.embedding_model` is the cursor; the reembed
  worker migrates per document atomically (new rows in + pointer flip + stale cleanup in one TX; readers never see a half-migrated
  doc). Published snapshots pin `embedding_model` + full `knowledge_config` per pin — old versions know the space they were indexed in.
- Readiness: `documents.state` machine + the degraded-pins publish gate (unresolved slugs refuse unless explicitly acknowledged).

## 2. RAG fixes to build (P0 — correctness bug first)

**BUG-1 — model-scoped vector search.** The vector leg compares the query vector against ALL rows regardless of `e.model`. During any
migration window both generations coexist, so scores mix across spaces. Fix (no migration): thread the query's embedding model into
the vector leg — `... from embeddings e ... where e.model = $queryModel` (query embeds with the org configured model); for
version-pinned reads (runs), constrain to `(pinned document_version ids × pin.embedding_model)`. Unit: mixed-model fixture proves
cross-space rows never score. Integration: publish → reembed mid-flight → recall parity.

**GAP-1 — embedding coverage gate.** READY doc ≠ vectors indexed for the CURRENT model. Add coverage derived per (document,
model): every chunk of the current document_version has an embedding row with `model = documents.embedding_model`. Pins lacking
full coverage count as degraded (publish refuses / acknowledged-bypass path, same UX as unresolved slugs). Worker flips the cursor
only at chunk-count parity (extend existing atomic swap). No new table unless the derived query proves too hot — then materialize
`document_embedding_coverage {document_id, model, chunk_total, chunk_embedded, status}` maintained by the ingestion/reembed TXs.

## 3. Execution perimeter (P4)

Present and untouched: MCP external-gateway execution, effect classes, approval chain, retry posture, per-run caps, tool blocks.
Add to `tool_catalog` (+ mirrored onto publish-time `toolBindings`): `execution_environment`
(`in_process|sandboxed_microvm|external_gateway`, default `external_gateway` for HTTP tools; code/SQL tools REQUIRE
`sandboxed_microvm` — validation refuses otherwise) and `allowed_egress_domains` (required when the tool performs outbound HTTP;
empty = no egress). `authorizeToolCall` enforces both fail-closed (wrong environment / non-whitelisted domain → typed refusal +
audit). Add `tool_execution_mode` (`live|shadow`) per binding: shadow executes nothing, persists a shadow tool-call record + audit
`tool.shadow_executed`, and the agent receives a simulated-result envelope explicitly marked `simulated: true` (never shaped like a
real result — the honesty rule). Catalog create/update validation + publish pin checks + effect×environment×mode test matrix.

## 4. Streaming economics (P2)

Present and untouched: run-scope budget enforcement, usage ledger (estimated→settled, idempotent, reconciled), quota reservations,
burn-rate auto-pause, provider reconciliation, rollups. Build: **(a) StreamingAccumulator** in the run loop — per-chunk usage
accumulation during SSE; breach of `max_cost_micros`/`max_output_tokens` mid-flight severs the stream and fails the run
`budget_exceeded_mid_stream` (typed, audited; partial usage still ledgered as estimated). **(b) Cache economics** — add
`prompt_cache_hit_tokens/miss_tokens` (+ cached/uncached cost split) to usage-ledger writes and the run manifest; invoice
derivation prefers the split when present, falls back to totals (no restatement of history). **(c) Overflow routing** — pre-call
context estimate vs model window: over-window triggers summarize-first (per `context_policy`) or routes to an allowed fallback with
a larger window; blind over-window calls refuse with a typed error. Tests: breaker trip fixture, split-ledger golden, overflow matrix.

## 5. Memory hardening (P3)

Correction recorded: the architecture already separates episodic (thread) from semantic (`memory_items` + ACL + TTL + soft-delete +
temporal validity + approval-gated writes). Build the three residuals: **(a)** `memory_pii_scrubbing` (`off|redact|block`, default
`redact`) on the memory write path (proposals at approval + direct writes), reusing `pii.ts` — redact annotates, block refuses.
**(b)** content-addressed purge: `purgeMemoryByContent` (org-scoped, per-row audit, DSR-suitable "forget my SSN") beside the existing
id-scoped delete. **(c)** `context_policy.memory_ttl_default` (seconds, optional, validated range) applied to new items lacking
`expiresAt`. Validation + service + redaction/purge/TTL tests.

## 6. Observability & alignment (P1 + P5)

Correction recorded: OTLP/HTTP exporter exists and is correctly env-gated; Prometheus owns metrics by design. Build **(a)** the span
layer (P1 — before everything else, so later phases are observable): `run → llm.call` (model, params hash, cache split, latency),
`rag.retrieval` (variant count, top scores, pin ids), `tool.execution` (binding id, effect class, approval outcome, shadow flag),
`guardrail.check` (policy, verdict, mode). Traceparent flows run-acceptance → workers. Attributes carry ids + hashes ONLY (never
prompts, PII, or secrets). Env-off = zero-cost no-op. Span-shape unit tests. Build **(b)** drift-triggered shadow evals (P5):
watcher compares live catalog entry hash vs published `modelRef.entry_hash`; on change, enqueue a shadow eval (existing pipeline,
shadow-flagged, never gates) on the assistant's seeded dataset; a PASS→WARN/BLOCK drop notifies the owner via the existing notify
fan-out and marks provenance `model_drift`. Alert-first: auto-rollback/auto-pause on drift is explicitly OUT of v1 scope.

## 7. Schema micro-adjustments (corrected, phased)

1. **Credentials** — mechanism covered. Add ONLY `revocation_reason` + `compromised` boolean (incident semantics: compromise blocks,
   alerts the owner, and flags sibling credentials for rotation review; the row is never deleted so manifest joins stand). Tiny
   migration + service branch + test. (P6)
2. **`parent_version_id`** — confirmed missing. Nullable self-ref on `assistant_versions`, set on draft-from-version and
   rollback-as-new; `rollback_of` keeps its rollback-marker meaning. Surfaced read-only in provenance lineage. Migration (backfill
   null) + tests. (P6)
3. **`guardrail_execution_mode`** — confirmed missing. Per-check `blocking|logging` (default blocking) in `guardrail_policy`
   (+ validation enum + G4-style enforcement branch in moderation/spotlight/PII paths). Logging records verdict + would-block +
   audit, never severs. logging→blocking is a definition change (new draft, auditable — never a silent flip). Mode matrix tests
   (P3 with memory work).
4. **Degraded TTL lifecycle** — confirmed missing. `degraded_until` (default +7d) set on any publish-with-bypass; assistant reads
   surface `DEGRADED`; runs keep acceptance (state, don't silently fail) with banner truth; owner alerted at publish and T-24h via
   notify; past TTL without resolution → auto-suspend through the existing disable path (`reason: degraded-ttl`, audited, reversible).
   Retention purge unaffected. (P5 with drift work.)

## 8. Engine-first build order (dependencies, not preferences)

| Phase | Work | Why this order |
|---|---|---|
| P0 | BUG-1 model-scoped vector search + GAP-1 coverage gate | Correctness bug; everything RAG stands on it |
| P1 | OTEL span layer (§6a) | Observe all later phases from birth |
| P2 | Streaming breaker + cache economics + overflow routing (§4) | Money burns while streams are open |
| P3 | Guardrail modes + memory scrub/purge/TTL (§5a–c, §7.3) | Safety + compliance, one test matrix |
| P4 | Execution environment + egress + shadow tools (§3) | Perimeter before wider rollout |
| P5 | Drift shadow evals + degraded-TTL lifecycle (§6b, §7.4) | Continuous alignment, alert-first |
| P6 | Credential incident flags + `parent_version_id` (§7.1–2) | Small, independent, last |

Per-phase gates (no exceptions): migration applies cleanly up AND down; zod/DTO validation unit tests; service/integration tests on a
live DB; full engine suite batch green (the one known `outbox` parallel flake re-proven pre-existing if it appears); live HTTP proof
on a scratch org; ledger entry in this doc's §10 record (to be appended as phases land).

## 9. Frontend, later (pointers only — not this goal)

Builder/fleet surfaces eventually needed: DEGRADED banners + resolve flow; drift/shadow badges on versions; logging-vs-blocking
indicators on guardrails; provider-compromise alerts; lineage view (parent chain); cache-split cost display. Nothing here changes the
builder blueprint's contracts — these are additive reads on fields this plan creates.

## 10. Implementation record

- 2026-09-17: review written and verified. Build started engine-first, one phase at a time.
- P0 DONE: BUG-1 model-scoped vector search (`retrieval.service.ts`: `e.model = queryModel` on the document leg,
  NULL-inclusive model predicate + foreign-row top-up exclusion on the memory leg; query model resolved by the same
  `configured ?? service-default` rule the re-embed worker uses; both write paths stamp `embedding_model`).
  GAP-1 embedding coverage gate (`KnowledgePin.embedding_coverage`, `undercoveredPinSlugs`, publish refusal with
  counts unless acknowledged, audited waived pins, live coverage in knowledge-health, worker chunk-parity before
  pointer flip + per-document tick isolation). Migration `0064_embedding_model_scope` (memory_items.embedding_model +
  index; embeddings UQ already existed — verified, not duplicated). Tests: unit 4 + integration 6 (model-scope 3,
  publish-gate 3). Suites: unit 33/220, integration 14/63 green. Corrections to the review found during build:
  date-stage `total > 0` vacuity rule, VALUES-paired per-(version,model) health aggregate, memory top-up back-door
  exclusion.
- P1 DONE: span helper (`common/observability/spans.ts`: W3C minting, attribute law — ids/hashes/counts only, withSpan
  error-preserving semantics). `run.accept` root span; trace id minted at accept when absent, pinned into run_manifest
  JSON + run.created outbox event (caller-supplied ids flow through). `rag.retrieval` on both legs (query_hash, never
  raw text). `tool.authorization` (deny reasons as hashes). `run.dispatch` correlated by `run_trace_id` attribute
  (proto contract untouched — true parentage deferred to the Studio contract change, recorded). `guardrail.check` +
  `llm.call` explicitly studio-runtime-owned (moderation hook runs there), not built here. Tests: unit 9 + integration
  2. Suites: unit 34/229, integration 15/65 green (outbox dead-letter ERROR lines are expected test output).
- P2 DONE: cache economics (`model_cost_entries.cost_micros_per_1k_cached_input`, migration 0065; split-aware
  `estimateCostMicros` with legacy fallback; `normalizeUsageCacheSplit` — lone-half derivation, exact-sum enforcement
  as 422; commit ledger metadata carries the split only when reported; staff upsert + costs route expose the rate).
  Wall-clock watchdog (`failRunForBudget` on ConversationsService mirroring cancelRun: FAILED + terminal event +
  quota release + run.failed outbox + audit; `RunWatchdogWorker` ticking every 60s over RUNNING/DISPATCHED past their
  pinned wall_clock, per-candidate isolation, optional org scope as a test seam; WAITING_* never touched; unset/0
  budgets unenforced by design). Overflow enabler (`modelWindows` on the authorized context from the GLOBAL catalog,
  null for unknown, advisory-failure-safe). Tests: unit 8 + integration 4. Suites: unit 35/237, integration 16/69
  green. Robustness found during build: new suites initially starved the outbox dispatcher's global batch on the
  shared DB — fixed with full `cleanupOrg` hermeticity + scoped watchdog tick (no cross-org side effects);   incident
  side note: the first unscoped tick correctly failed 12 pre-existing stuck RUNNING runs with breached wall clocks
  from earlier sessions (their run.failed events left for the production dispatcher — real signals, not deleted).
- P3 DONE (with one documented correction: memory TTL/scrub live in org_settings.preferences, NOT context_policy —
  memories are org-scoped entities approved across runs/agents, so per-agent TTL would apply incoherently; per-agent
  memory_scope still governs assembly surfaces). Guardrail `execution_mode` (blocking|logging, default blocking)
  versioned in validation + DTO, handed to Studio in the authorized context (legacy snapshots resolve blocking),
  observed per run via the `run.context` span policy attrs; verdict enforcement stays Studio-side (moderation hook
  runs in the runtime — recorded pointer, not built here). Memory governance: scrub off/redact/block on both write
  paths (scrub-before-embed ordering law; redact audits counts only; block is 422), TTL default when no expiry set,
  content purge (single UPDATE...RETURNING, LIKE-escaped literal, 3-char floor, hashed audit, bounded ids). Route
  POST memories/purge (owner/admin, idempotent). Tests: unit 3 + integration 6. Suites: unit 36/240, integration
  17/75 green. Open note: one purge run returned 0 with identical code, then 2 on re-run with no changes — cause
  not isolated; the test now asserts the pre-purge marker count so any recurrence fails loudly at setup, and the
  statement was independently probed correct on live SQL.
- P5 DONE: shadow evals (eval_runs.is_shadow, migration 0067; startRun shadow flag + payload marker; release gate
  AND provenance verdict both exclude shadow — a shadow BLOCK neither blocks shipping nor surfaces as the verdict;
  EvalService.detectModelDrift — entry_changed/removed/disabled vs live catalog with resolveModelRef hash-shape
  parity, fail-open to silence without a catalog; startShadowEval — 24h dedup, no_dataset honesty, actor
  system:model-drift; ModelDriftWorker hourly, per-candidate isolation, owner/admin warn+email either way).
  Degraded lifecycle (assistants.degraded_until/reason/alerted_at; waived publish starts 7d, healthy clears, in
  the same TX; AssistantsService.sweepDegradedAssistants — overdue suspends via the disable path, due-soon marks +
  audits once; DegradedSweepWorker fans out; already-disabled rows never touched). Tests: integration 3 (gate +
  verdict exclusion incl. formal-BLOCK control, drift/dedup/alert, clock/clear/sweep/once/accept-refusal).
  Suites: unit 37/250, integration 19/82 green. Fixes during build: no-op joint rule (above) caught by the
  draft-eval suite; verdict read needed a documented template-stub (shared-helper philosophy); afterAll ordering
  for FK-bound eval rows.
- P6 DONE: credential incident flags (revocation_reason + compromised, migration 0068; revoke accepts both,
  compromise pages owner/admin error+email and audits a distinct action; rotate/list/read paths unchanged —
  terminal status, active-only reads, history rows never deleted; view + controller surface the fields).
  Version lineage (parent_version_id: active-at-draft-creation, REBASED onto active at every updateDraft edit —
  a draft saved while v3 is active derives from v3, not its ancient fork point; rollback-as-new parents the
  restored version; publish inherits the draft's; import flows through creation; surfaced read-only in
  provenance). Tests: integration 2 (compromise vs routine incl. rotate-refusal + row survival + double-revoke
  refusal; full chain draft→publish→edit→publish→rollback + provenance reads). Suites: unit 37/250,
  integration 20/84 green; `npm run build` clean; full Nest boot verified (new workers resolve in DI; the
  3001 holder at check time is the developer's own engine, untouched). Shared-helper improvement: templates
  signal stub promoted into buildAssistantsService (provenance-readable everywhere; install paths still explode
  loudly).
- P4 DONE: perimeter columns on tool_catalog (migration 0066: execution_environment default external_gateway,
  allowed_egress_domains + backfill of binding hosts for existing http rows). `normalizeToolPerimeter` (fail-closed
  rules: env enum, in_process purity, http/host coverage, hostname validation; hash intentionally EXCLUDED — schema
  identity must not churn template pins; perimeter pins separately). Upsert writes both paths + audit; PUT and
  from-template routes admit the fields (template tools default [binding host], recorded). Version entries gain
  execution_mode (live|shadow, default live); bindings pin env + egress + mode; manifest hash covers them.
  authorizeToolCall enforces drift-deny (live row vs pin, legacy pins skip), returns shadow, audits + spans it.
  Course correction during build: identical-content re-publish over DRIFTED catalog hit the content-hash no-op
  guard (stranding re-pins) — and a naive manifest-only switch broke prompt-only iteration (manifest excludes the
  prompt). The guard now refuses only when content AND manifest both match active (joint rule), with legacy
  fallback; eval gates stay content-keyed. Regression tests pin all three cases + the concurrent-publish race.
  Tests: unit 10 + integration 4. Suites: unit 37/250, integration 18/79 green.
