# AI Harness Gap Analysis & Plan — pre-publish review

> Status: PARTIALLY IMPLEMENTED (2026-09-12) — H0 Engine side + Studio execution path landed with contract v1.1; H0 exit-gate verification and H1/H2 remain. Implementation summary at the bottom.
> Scope: the end-to-end "harness" — everything between a user message and a completed, observable, safe agent response — across Engine (control plane, built) and Agent Studio (execution plane, 0%, planned).
> Method: manual code reading of the Engine as built + the Neryva MCP contract + the Studio blueprint, benchmarked against the 2025–2026 state of the art (protocol specs, shipped chat-product harnesses, agent SDKs, research). Sources at the end.

---

## 1. What "the harness" means here

A modern AI harness is the loop:

```
accept input → authorize → assemble context (instructions + history + memory +
knowledge + tool schemas + budgets) → call model → validate policy → execute
tools (scoped, approved, idempotent) → stream tokens → persist durable events →
commit result → account usage → observe/evaluate → remember
```

Neryva splits it: **Engine owns business truth and authorization** (conversations, runs, events, policy, usage, retention), **Studio owns execution** (agent loop, context compiler, model gateway, tool gateway), **Neryva MCP is the authorized boundary** between them. This split is correct and matches where the industry is going (platform/authority separated from runtime; durable execution delegated to Temporal). The gaps below are therefore mostly about *what flows through the boundary*, not about the boundary itself.

---

## 2. Harness as built — Engine inventory (verified by reading the code)

### 2.1 Strong (at or above the modern baseline — do not weaken)

| Capability | Evidence |
|---|---|
| Immutable messages, per-conversation monotonic sequence, run pinning to assistant_version + policy_snapshot | `src/modules/conversations/schema.ts`, `drizzle/0022` |
| Durable semantic run events with dedup + authoritative `engine_sequence` ordering | `run_events` (`drizzle/0022` + `drizzle/0029` event identity) |
| Run authority: lease CAS/fencing (`lease_epoch`), AppendRunEvents dedup, CommitRunResult atomic commit + conversation version CAS, FailRun | `src/modules/conversations/mcp-authority.service.ts` |
| Human-in-the-loop approvals; tool authorization/outcome records (`tool_effects`); checkpoints; approval-gated memory proposals | MCP contract approval/tool/checkpoint/memory services |
| Claim-check ArtifactRef facade (7 fresh checks), tenant-bound object keys | `src/modules/knowledge/artifacts.service.ts` |
| Tiered idempotency (Redis lease + DB authority), outbox/inbox with three-state claims, accepted-run sweep (invariant 6) | `src/common/http/idempotency*`, `src/common/infra/outbox/*`, `src/workers/accepted-run-sweep.worker.ts` |
| RLS `ENABLE + FORCE` on all tenant tables, `withOrg`/`withBypass`, append-only hash-chained audit, usage ledger with quota reservations + reconciliation, retention/purge/legal-hold/export/tombstones | Phases 0–2, 8, 9 |
| Channel plane: WhatsApp/Messenger/Telegram/web widget with durable ingest, signature verification, window policies, claim-before-send | Phase C (`src/modules/channels/`) |

This matches or exceeds what open-source harnesses (LangGraph, OpenHands, Mastra) provide on the *governance* axis. Most OSS has nothing comparable for multi-tenant billing, retention, or audit. This is Neryva's differentiator — keep it.

### 2.2 Stubbed or missing — the harness cannot actually run an agent end-to-end today

These were verified by reading the code, not inferred:

1. **No system prompt / instructions anywhere.** `assistant_versions` has `model/context/tool/knowledge/guardrail` policies but **no `instructions` column** (`src/modules/assistants/schema.ts:44-79`); the validation schema has no such field (`src/modules/assistants/validation.ts:3-37`); the MCP `ContextManifest` carries only `assistant_version_id` as a string (context/v1/context.proto). The Studio blueprint's agent definition explicitly requires `"instructions": "..."`. **The model would have no persona or task definition.**
2. **No model generation parameters.** `model_policy = {allowed_models, fallback_enabled}` only — no temperature, max output tokens, reasoning/thinking budget, top_p, stop sequences, or structured-output schema. `RunBudgets` has `max_tool_calls / max_model_calls / max_output_bytes` but **no token or cost budget** and no wall-clock deadline (context/v1/context.proto).
3. **Tool descriptors carry no schemas.** `ToolDescriptor {name, effect_class, approval_requirement}` — no input JSON Schema, no description, no annotations (read-only/destructive/idempotent/open-world). A model cannot emit a valid tool call from this. There is **no tool catalog table** at all — `tool_policy.tools` is freeform names.
4. **Knowledge never reaches the run.** `getAuthorizedRunContext` returns `knowledgeRefs: []` unconditionally — no retrieval call is made (`src/modules/conversations/mcp-authority.service.ts:717+`). The Phase-7 pgvector plane with ACL-before-scoring exists but is unreachable from a run. There is also **no `SearchKnowledge` RPC**, so Studio cannot retrieve mid-run (agentic RAG).
5. **Memory has no content.** The manifest's `MemoryRef {memory_id, scope, provenance}` carries no text (`context/v1/context.proto`), and the Engine query selects only id/scope/provenance. The memory approval pipeline produces rows the runtime can never read.
6. **Summarization does not exist.** `conversationSummary: ''` is returned with the comment "Summaries land with Phase 4.6/7 — empty until then, never fabricated" — no summaries table, no job, and `context_policy.summary_enabled` is a dead flag.
7. **No token-level streaming.** `run_events` are durable semantic events (invariant 8); `AssistantDelta` is named in the Studio doc but has no contract event, no ephemeral transport, and Engine SSE replays durable events only (1s poll). Users would wait for the whole run to finish before seeing text.
8. **No message attachments.** C5 seam is documented; `MEDIA_TYPE_ALLOWLIST` is text-only (`artifacts.service.ts:21`); no upload path for user-to-run files. Every modern chat harness (claude.ai, ChatGPT, Qwen) treats images/PDF as table stakes.
9. **No guardrail enforcement.** `guardrail_policy` is strings (`'default'`, `'brand-safe'`) plus a `pii_redaction` boolean — nothing consumes it. No prompt-injection defense (spotlighting), no PII redaction executor, no output moderation hook, no untrusted-content marking in the manifest.
10. **No feedback/eval loop.** No message-feedback table or API; no eval datasets, runners, or regression gates (Studio plans an `eval-worker` but nothing Engine-side stores results).
11. **Retrieval is once-at-manifest-build only** — modern harnesses retrieve per model step (agentic RAG), especially with tool results in play.
12. **Smaller parity gaps:** no conversation titles/auto-naming, no full-text conversation search, no regenerate/branch model, no citations plumbing, no prompt-cache preparation hints, no usage reporting path in the contract (CommitRunResult usage entry was deferred).

---

## 3. The 2025–2026 reference landscape (what "modern" looks like)

### 3.1 Protocols

- **Model Context Protocol — spec `2026-07-28`.** Major shift: **stateless** protocol (no `initialize` handshake, no `Mcp-Session-Id`; per-request `_meta` carries protocol version + capabilities), `server/discover` capability advertisement, **tasks moved to an official extension** (`io.modelcontextprotocol/tasks`, `tasks/get` polling + `tasks/update` input), **Multi Round-Trip Requests** (`InputRequiredResult` → client re-issues with `inputResponses`), `CacheableResult` (`ttlMs`/`cacheScope`) and deterministic `tools/list` ordering **explicitly to improve prompt-cache hit rates**, JSON Schema 2020-12 for tool input/output schemas, OAuth **Client ID Metadata Documents** (DCR deprecated), OTel trace context via `_meta`. Roots/Sampling/Logging are **deprecated**.
- **Agent2Agent (A2A)** — Linux Foundation; 150+ organizations, production enterprise use, available in major cloud platforms. Relevant later for Neryva-to-Neryva or customer-agent interop, not for v1.

### 3.2 Shipped product harnesses (the UX bar to match)

- **claude.ai (Sept 2026):** memory for all plans (categorized memory entries, import/export), Projects (persistent context), Skills (procedural assets), Artifacts (interactive outputs, publishable), connectors directory + **MCP Apps** (interactive in-chat tools), code execution, web search, extended search (deep-research style) task types.
- **ChatGPT (2026):** agent mode absorbed into **ChatGPT Work** (multi-step tasks with browsing/Python/files), Deep Research **connects to arbitrary MCP servers** (Feb 2026), memory, canvas, connectors, projects, image generation.
- **OpenAI Responses API / Agents SDK:** hosted built-in tools — **web search, file search, code interpreter, hosted MCP, image generation, computer use** — plus sessions, guardrails, tracing, handoffs.
- **Claude Agent SDK:** layered kit — memory files (CLAUDE.md), **skills**, **hooks** (lifecycle interception points before/after model and tool calls), **subagents** (delegation), MCP, permission modes + sandboxing.

Common denominator across all of them: **attachments, streaming with reconnect, memory, retrieval with citations, code execution, connectors/external tools, feedback**. Neryva's widget + channels deliver the surface; the context supply chain and the built-in tools are the missing half.

### 3.3 Research & production systems worth borrowing from

- **Context engineering (Anthropic):** **compaction** is the first lever for long-horizon coherence; **context editing** (clearing stale tool calls/results) measured ~29% improvement; **memory tool + context editing** ~39%; server-side compaction recommended over client-side. Prompt-cache preparation interacts with editing (cleared prefixes invalidate caches) — ordering and breakpoints are a Context Compiler responsibility.
- **Memory:** three production archetypes — **Mem0** (fact extraction store), **Zep/Graphiti** (temporal knowledge graph; arXiv:2501.13956), **Letta/MemGPT** (self-editing memory). Neryva's propose→approve→store-with-provenance model is closest to a governance-first Mem0; add temporal metadata (valid_from/invalid_at) and read-side content delivery rather than adopting a framework.
- **Retrieval (2026 consensus):** parallel **BM25 + dense vector → RRF fusion → cross-encoder reranker**; +8–15% accuracy over single-method; chunking quality is the #1 lever, reranking #2; pgvector + PostgreSQL FTS is production-viable (matches the Studio doc's hybrid-retrieval stance).
- **Safety:** defense-in-depth — **spotlighting** (delimiting/datamarking/encoding of untrusted content, arXiv:2403.14720), **LlamaFirewall** stack (PromptGuard 2 86M input classifier, AlignmentCheck for goal drift, CodeShield for generated code), architectural controls (least privilege, egress restriction — Neryva already has the tool gateway shape for this). No single defense suffices; benchmark with injection suites.
- **Evaluation:** execution-based verification is the gold standard (**tau2-bench** for tool-agent workflows checks end state; SWE-bench Verified for coding; GAIA/OSWorld for general agents); `pass^k` reliability metrics; LLM-as-judge rubrics for open-ended output; benchmark integrity is a known problem — prefer customer-configurable eval suites over public-leaderboard chasing.
- **Observability:** OpenTelemetry **GenAI semantic conventions are still Development status as of mid-2026** (chat/embeddings most mature, agent spans least). Adopt `gen_ai.*` with a **pinned semconv version** in one telemetry module; do not build business logic on attribute names. Neryva's durable `run_events` are actually a *better* audit-grade substrate than trace spans for business events — use both, coalesced.
- **Sandboxes:** E2B (Firecracker microVMs, ~150ms cold start, the AI-first default), Daytona (in-place pause/resume ~742ms), Modal (GPU/serverless), Cloudflare Sandboxes (V8 isolates + Durable Objects), Vercel Sandbox. **Adopt, never build** — this is exactly the "frameworks are replaceable adapters" boundary.
- **Streaming:** AI SDK 5 **UIMessage stream protocol** — SSE with named events, keep-alive pings, and **resumable streams** (server persists the active stream; client reconnects with a chat ID and a server-side cursor). Neryva's durable-event replay already gives resumability for semantic events; the pattern needs extending to token deltas (ephemeral) without polluting `run_events`.

---

## 4. Gap analysis & priorities

Priorities assume "publish" means: customers can create an assistant, talk to it (web + channels), and trust it — not that every frontier feature exists.

| # | Gap | Modern reference | Priority | Where it lands |
|---|---|---|---|---|
| G1 | Assistant `instructions` (system prompt) | universal | **H0 publish blocker** | Engine schema + snapshot + MCP manifest |
| G2 | Model/generation params + token/cost/wall-clock budgets | all SDKs | **H0** | Engine policy schema + `RunBudgets` |
| G3 | Tool catalog with JSON Schemas + annotations (read-only/destructive/idempotent/open-world) | MCP tool schema+annotations; OpenAI built-ins | **H0** | Engine `tool_catalog` + `ToolDescriptor.input_schema` |
| G4 | Knowledge retrieval wired into run context + mid-run `SearchKnowledge` | every RAG product | **H0** | Engine context assembly + new RPC/op |
| G5 | Memory content delivery (read path) | Mem0/Letta/Zep | **H0** | `MemoryRef.content` (bounded) or `GetMemories` |
| G6 | Conversation summarization (compaction) | Anthropic compaction | **H0 (basic)** | Engine `conversation_summaries` + worker |
| G7 | Guardrail enforcement baseline: spotlighting of untrusted content, PII redaction executor, moderation hook | LlamaFirewall / spotlighting | **H0** | Engine `common/guardrails` + Studio consumption |
| G8 | Token streaming (ephemeral deltas) + resumable streams | AI SDK 5 UIMessage | **H0** | Contract `AssistantDelta` + Redis pub/sub + SSE merge |
| G9 | Message attachments (images/PDF inbound; generation later) | universal | **H0/H1** | artifacts purpose + `BoundedMessage.artifact_ref` (already in proto) |
| G10 | Message feedback capture (up/down + reason) | universal | **H1** | Engine `message_feedback` + outbox → eval |
| G11 | Citations plumbing (chunk → cited message span) | claude.ai/ChatGPT citations | **H1** | KnowledgeRef chunk offsets + message content part |
| G12 | Hybrid retrieval (BM25+vector RRF) + reranker hook | 2026 RAG consensus | **H1** | Knowledge plane extension (Studio doc already calls for it) |
| G13 | Conversation full-text search + titles | universal | **H1** | tsvector GIN + title generation job |
| G14 | Usage reporting in contract (`RecordUsage` or CommitRunResult usage) | all SDKs | **H1** | Contract change (deferred Phase 8 item) |
| G15 | External MCP client / connectors (OAuth vault) | ChatGPT connectors, Deep Research over MCP, Claude connectors | **H1/H2** | `connector_accounts` + Tool Gateway adapter |
| G16 | Sandbox (code execution tool) | E2B/Daytona/Cloudflare | **H1/H2** | Studio `tool-worker` + adopted sandbox |
| G17 | Eval system (datasets, runners, pass^k, LLM-as-judge) | tau2-bench methodology | **H1/H2** | Engine stores results; Studio `eval-worker` runs |
| G18 | Web search tool | universal | **H2** | Built-in tool via Tool Gateway (hosted provider) |
| G19 | Sub-agents / multi-agent, skills, A2A | Claude Agent SDK / A2A | **H2** | Design docs first |
| G20 | Regenerate/branch conversations | universal | **H2** | Design doc (messages are immutable by invariant) |
| G21 | GenAI semconv traces (pinned version) | OTel GenAI | **H2** | Studio telemetry module + Engine run correlation |
| G22 | Image generation, voice/realtime, computer use | product frontier | **H2+** | Out of scope pre-publish |

Also noted, no action needed: **A2A** (watch), MCP **tasks extension** (Neryva MCP already has its own superior run/task model — do not import), MCP stateless mode (Neryva MCP is already stateless per-request capability auth — aligned by accident, good), prompt-cache hints (Context Compiler concern; MCP's deterministic `tools/list` ordering rationale applies to manifest ordering).

---

## 5. Adopt vs build (wheel inventory)

| Capability | Decision | Rationale |
|---|---|---|
| Durable execution | **Adopt Temporal** (already decided) | Do not rebuild retries/timers/signals |
| Model provider adapters | **Adopt Vercel AI SDK Core / official SDKs behind the Model Gateway** (already decided) | Pin major; conformance tests per provider |
| Sandbox | **Adopt** E2B or Daytona (self-hostable) or Cloudflare Sandboxes; decide in H1 spike | Firecracker/gVisor ops is not Neryva's differentiator |
| Guardrail classifiers | **Adopt** PromptGuard 2 / provider moderation behind Neryva policy interface; **build** spotlighting encoder + policy layer (small, ours) | Classifiers are commodities; the policy/audit layer is the product |
| Memory framework | **Build** read/write paths; **borrow** temporal metadata pattern from Zep/Graphiti; **do not adopt** Mem0/Letta as a dependency | Memory policy is customer-facing product truth |
| Hybrid retrieval | **Build** on pgvector + PG FTS + RRF (native); optional reranker adapter | Studio doc already prescribes this; no new infra |
| External tools | **Adopt MCP** as the connector protocol (Tool Gateway adapter wraps external MCP servers) | 2026 industry default; Studio doc allows the adapter |
| Streaming protocol | **Adopt** the UIMessage-SSE pattern (named events, ping, resume-by-cursor) for widget/UI; keep Neryva MCP events as the durable source | Interop with the planned AI-SDK-based frontend |
| Evals | **Build** Neryva eval schema; **borrow** tau2-bench execution-verification methodology and pass^k metrics | Evals must run against Neryva's durable event log |
| Agent protocols (A2A) | **Watch** | No inter-agent interop requirement at publish |

---

## 6. Plan

### H0 — publish blockers (Engine-led; Studio consumes)

**H0.1 — Assistant definition v2: instructions + model params**
- Migration `0031_assistant_instructions.sql`: `assistant_versions` + `policy_snapshots` gain `instructions text` (bounded, e.g. ≤ 32 KiB, CHECK) and `model_params jsonb` (validated: temperature 0–2, max_output_tokens, top_p, reasoning_effort enum, structured_output_schema optional JSON Schema ≤ 4 KiB). Bump `ASSISTANT_SCHEMA_VERSION` to 2; extend `validation.ts` + `rejectUnknownModels` unchanged; export/import parity + hash updated.
- Contract: `ContextManifest.instructions` (string, bounded) + `ContextManifest.model_params` + `RunBudgets.max_total_tokens` / `max_cost_micros` / `deadline_at`.

**H0.2 — Tool catalog**
- Migration `0032_tool_catalog.sql`: `tool_catalog` (org-scoped rows today, platform rows later): name, version, description, `input_schema` JSON Schema, `output_schema`, effect_class, annotations (`read_only`, `destructive`, `idempotent`, `open_world`), enabled, hash. `tool_policy.tools` entries gain `schema_hash` pinning (same pattern as model catalog pinning in publish) so runs can never see a mutated schema.
- Contract: `ToolDescriptor` gains `description`, `input_schema`, `annotations`. Studio's Tool Gateway validates args against this schema; AuthorizeToolCall binds the call to the schema hash.

**H0.3 — Wire the context supply chain** (the single highest-value change)
- `getAuthorizedRunContext` becomes a real assembler: instructions + model params (from snapshot), recent messages (existing), **summary** (H0.4), **memory content** (bounded text, from approved `memory_items`), **knowledge**: run retrieval via the existing ACL-before-scoring service over the last user message (+ `KnowledgeRef` gains `snippet` bounded text + chunk offsets), tools (from catalog), artifacts (existing).
- New capability op + RPC `SearchKnowledge` (per-run, rate-limited by RunBudgets) for agentic retrieval; same ACL code path, results append as `run_events` of type `knowledge.retrieved`.
- `MemoryRef` gains `content` (bounded ≤ 1 KiB) — keep `GetMemories` as a possible later RPC; manifest inline content is sufficient v1.

**H0.4 — Summarization / compaction**
- Migration `0033_conversation_summaries.sql`: `(conversation_id, source_sequence)` unique, summary text, token_count, model, created_at. Engine worker (outbox consumer on message-appended, threshold by `context_policy.history_limit`) generates summaries via Model Gateway policy (Studio exposes an internal summarization route OR Engine calls the provider directly — decide: **Engine calls Model Gateway over internal HTTP, keeping provider credentials in Studio**; alternative is a `SummarizeConversation` MCP RPC. Recommend the RPC: one credential owner).
- Manifest assembly uses the newest summary with `source_sequence >= oldest included message` — classic compaction, durable and replayable.

**H0.5 — Guardrail baseline (enforcement, not just policy strings)**
- `src/common/guardrails/`: (a) **spotlighting encoder** — all untrusted content (knowledge snippets, tool results, channel/user free text injected into prompts, memory content) is delimited + datamarked with a Neryva constant and an untrusted-source tag; (b) **PII redaction executor** (regex + allow/deny config v1, provider classifier later); (c) **moderation hook interface** with a no-op dev impl and one production impl (provider moderation API or PromptGuard 2 via an internal service); (d) policy resolution from `guardrail_policy` strings → concrete pipeline; deny-closed in production when a configured guardrail cannot run.
- Output guardrail writes a `run.guardrail_blocked` event instead of committing a message (reuses FailRun/commit path).

**H0.6 — Token streaming without breaking invariant 8**
- Contract: `run_events` gains event type `assistant.delta` declared **ephemeral**: Engine MAY prune delta events after finalization (retention class `transient`), and they are excluded from billing/audit surfaces. Alternatively (cleaner): deltas stay **out of the contract** — Studio streams deltas over an Engine SSE fan-out using Redis pub/sub keyed by run id; durable semantic events remain the only contract events. **Recommend the Redis fan-out**: no contract churn, no pruning semantics, widget/stream consumers merge `replay (durable) + live (ephemeral)` with the existing sequence cursor as the join point.
- Engine SSE endpoints (`/conversations/:id/runs/:runId/events/stream`, widget stream) add `delta` named events + keep-alive pings + `Last-Event-ID`-style resume for the durable portion (already implemented).

**H0.7 — Message attachments (inbound)**
- Migration `0034_message_attachments.sql` (or artifacts-purpose extension): upload-session flow already exists; add purposes `message_attachment` (+ `message_generated` later), extend `MEDIA_TYPE_ALLOWLIST` to `image/png|jpeg|webp`, `application/pdf` with per-type byte caps; messages `content` gains an `attachment` part referencing `artifact_id`; `BoundedMessage.artifact_ref` already exists in the contract — manifest fills it.
- Studio `GetAttachment` = existing `GetRunArtifact` (no new RPC; verify purpose binding).

**Exit gates H0:** a scripted end-to-end run: create assistant v2 (instructions + params + catalog tool) → send message → GetAuthorizedRunContext returns instructions/knowledge/memory/summary/tool schema → Studio-shaped fake runtime completes a tool call with approval → deltas observed on SSE while durable events dedup → result committed exactly once → usage reserved/committed → feedback recorded. Plus the standing negative suites (RLS, cross-tenant retrieval, forged capability).

### H1 — parity + differentiators (immediately post-publish)

- **H1.1 Feedback + eval loop:** `message_feedback` (unique per message+account, rating, reason enum, bounded comment) → outbox → `eval_datasets`/`eval_runs` (pinned assistant version, model, dataset item refs to real conversations, pass^k aggregation, LLM-as-judge config) stored Engine-side; Studio eval-worker executes against the durable event log.
- **H1.2 Hybrid retrieval + reranker:** PG FTS (tsvector on chunk text) + pgvector in parallel, RRF fusion, optional cross-encoder reranker adapter (provider-agnostic interface, default off). Chunking audit (the #1 lever) as a knowledge-plane task.
- **H1.3 Citations:** `KnowledgeRef` chunk offsets + assistant message `citation` content parts referencing `{document_id, chunk_id, span}`; widget renders source list.
- **H1.4 Conversation search + titles:** generated tsvector column + GIN on messages (org-scoped search endpoint, RLS-tested); title generation on first exchange (cheap model, outbox worker).
- **H1.5 Usage in contract:** `CommitRunResult.usage` or dedicated `RecordUsage` — reconcile with the Phase 8 outbox-driven usage consumer (keep outbox as authority; the RPC is a fast-path hint, the ledger stays compensable).
- **H1.6 Sandbox decision spike:** run the Studio `tool-worker` with E2B (self-host) vs Daytona vs Cloudflare Sandboxes against the failure-injection suite; pick one; expose `code_interpreter` as the first catalog tool (READ_ONLY, network-denied by default).
- **H1.7 External MCP connectors:** `connector_accounts` (org, provider, sealed OAuth tokens `enc:v1:`, scopes, rotation via existing envelope pattern); Tool Gateway adapter speaks MCP `2026-07-28` (stateless, `server/discover`, tool schemas cached per `ttlMs`); connector tool calls flow through AuthorizeToolCall + audit like native tools.

### H2 — frontier (design docs before code)

Sub-agents (capability-scoped child runs), skills (procedural assets in assistant versions), A2A interop, regenerate/branch conversation model, image generation, voice/realtime, computer use, GenAI semconv trace module with pinned semconv version, prompt-cache-aware manifest ordering (deterministic tool ordering + cache breakpoints documented for the Context Compiler).

---

## 7. Risks & non-goals

- **Do not import MCP tasks** — Neryva MCP's run/lease/approval model is strictly stronger (fenced leases, CAS commits, approval ledger). Align vocabulary, not mechanics.
- **Do not let the Model Gateway leak** — all H0 provider-touching features (summaries, moderation, titles, eval judges) must go through one credential owner; no second secrets store.
- **Deltas are ephemeral by design** — any temptation to persist token streams into `run_events`/audit is an invariant-8 violation.
- **Contract changes are additive** — proto3 optional fields + new RPCs only; no field reuse; `schema_version` bump; Studio consumes via `@neryva/mcp-contract` (regenerate, never hand-edit).
- **Everything above is engine-led and flag-gated** (`MODULES__*` + new `HARNESS__*` flags), so H0 can land behind flags before the first full CI/DB run closes the standing Phase C/3–10 exit gates.

## 8. Sources (researched 2026-09-12)

- MCP spec `2026-07-28` changelog — modelcontextprotocol.io/specification/latest/changelog
- A2A at the Linux Foundation (150+ orgs, production) — linuxfoundation.org press, glukhov.org 2026 analysis
- OpenAI Responses API / Agents SDK built-in tools — openai.github.io/openai-agents-python/tools/, openai.com/index/new-tools-for-building-agents/
- Claude product harness (memory entries, artifacts, MCP Apps, connectors) — support.claude.com, claude.com/blog, suprmind.ai/hub/claude/features/ (Sept 2026)
- ChatGPT 2026 (Work, Deep Research over MCP) — chatgpt.com/work/, suprmind.ai/hub/chatgpt/features/, composio.dev
- Claude Agent SDK layers (skills/hooks/subagents/MCP) — penligent.ai, levelup.gitconnected.com, morphllm.com/ai-agent-framework
- Context engineering (compaction, context editing, memory tool; 29%/39% figures) — platform.claude.com cookbook, anthropic.com/engineering/effective-context-engineering-for-ai-agents, hyperdev.matsuoka.com
- Memory systems — Mem0/Zep (arXiv:2501.13956)/Letta comparisons (theaiengineer.substack.com, getzep.com, mem0.ai)
- Retrieval consensus (BM25+vector+RRF+rerank, +8–15%) — dbi-services.com, digitalapplied.com, ubuntu.com/blog
- Guardrails — LlamaFirewall (arXiv:2505.03574, meta-llama.github.io/PurpleLlama), spotlighting (arXiv:2403.14720, MSRC 2025), tldrsec/prompt-injection-defenses
- Evals — tau2-bench/SWE-bench/GAIA comparisons (decodethefuture.org, swebench.com, prefactor.tech, Berkeley benchmark-integrity audit)
- Sandboxes — E2B/Daytona/Modal/Cloudflare comparisons (northflank.com, koyeb.com, superagent.sh, logrocket.com)
- OTel GenAI semconv still Development — opentelemetry.io registry, praesidia.ai, greptime.com (May 2026)
- Streaming — AI SDK 5 UIMessage stream protocol + resumable streams (ai-sdk.dev)

---

## 9. Implementation status (2026-09-12)

**Landed (code, typecheck-clean; DB-backed gates await the first full CI/DB run):**

- **Contract v1.1** (`neryva-mcp-contract@0.2.1`): all G1–G5/G14 contract surfaces — `ContextManifest.instructions`/`model_params`/`allowed_models`, `ToolDescriptor.description`/`input_schema_json`/`annotations`, `MemoryRef.content`, `KnowledgeRef.snippet`/`title`/`score`/source ranges, `RunBudgets` token/cost/wall-clock, `SearchKnowledge` + `SaveConversationSummary` RPCs, `CommitRunResult.usage` (`UsageEntry`). Additive only; `buf lint` clean; regenerated + built.
- **Engine**: migrations 0031 (instructions+model_params on versions/snapshots), 0032 (`tool_catalog` RLS table), 0033 (`conversation_summaries` + conversations.title), 0034 (`message_feedback`), 0035 (MESSAGE_ATTACHMENT/GENERATED_MEDIA purposes); assistant schema v2 with publish-time `assertPublishable` (instructions required) + `assertToolPins` (schema-hash pinning); tool-catalog module with CRUD + audit; `getAuthorizedRunContext` rewritten into the real assembler (spotlighting + PII redaction via the new `common/guardrails`); `SearchKnowledge`/`SaveConversationSummary` authority methods + routes + `search_knowledge` capability op; usage ledger entry in the CommitRunResult TX (replay-safe); feedback + title endpoints; SSE `delta` naming for AssistantChunk events.
- **Agent Studio**: `runtime-control` now actually LISTENS — ConnectRPC host for `RuntimeControlService` (StartRun/Cancel/DeliverInput/Status/Drain) with shared-token auth (fail-closed in production); inline executor implementing the full run loop (claim → context → pure compile → LiteLLM-gateway streaming with coalesced AssistantChunk appends → READ_ONLY tool authorize/record, approval propose-and-park → CommitRunResult with usage → SaveConversationSummary compaction → lease release); `compileContext` real (was a `trigger:<id>` stub); workflow fixes (real tool schemas to the model, run.version CAS on commit, model params, usage); MCP client v1.1 methods; AssistantChunk domain event.

**Remaining (unchanged from §6):** H0 exit-gate verification end-to-end; H1 items (feedback→eval loop wiring exists at the table/outbox level; hybrid retrieval, citations UI, search, sandbox spike, connectors); H2 items.
