# Final Implementation Ledger — Neryva AI Harness

> **Status:** FINAL for execution (2026-09-12). Supersedes the chat-draft feature list; complement to
> `docs/architecture/engine/ai_harness_plan.md` (gap analysis + research) and `docs/architecture/engine/imp/ledger.md`
> (engine phases 0–10, unchanged). This ledger is the execution order for the remaining harness work.
> **Rule (inherited):** a task is DONE only with code + test + evidence (CI / conformance / DB-gate run).
> DB-backed gates join the first full CI/DB run (`compose up + migrate + integration/isolation suites`) — until that
> run happens, completed tasks are marked `CODE_COMPLETE / GATES_PENDING`, never `DONE`.

## How to read this ledger

- **ID** `FL-<phase>.<seq>` — stable; reference in PR titles (one task per PR).
- **Status vocabulary:** `TODO` (not started) · `CODE_COMPLETE` (code landed, gates pending) · `GATES_PENDING` (awaiting the CI/DB run) · `DONE` (evidence in).
- **Priority:** `P0` publish blocker · `P1` immediately post-publish · `P2` later/frontier.
- **Owner:** Engine (this repo) · Studio (`products/agent-studio`) · Contract (`products/neryva_mcp`) · UI (consumer).
- **Exit-gate legend:** `RLS+` = RLS + app-predicate negative tests for new tenant tables · `CONTRACT` = buf lint/breaking + conformance fixtures · `MIG` = reviewed ordered migration + `ownership-map.json` delta · `EXPLAIN` = plans for new list/lookup queries · `SEC` = no secrets/prompt content in logs/traces · `E2E` = scripted end-to-end path.

---

## 0. Baseline — already implemented (do NOT re-scope)

Code complete 2026-09-12, all three repos typecheck/build/lint clean; DB-backed gates pending the first CI/DB run.

| Area | Delivered |
|---|---|
| Contract v1.1 (`@neryva/mcp-contract@0.2.1`) | `ContextManifest.instructions/model_params/allowed_models`; `ToolDescriptor.input_schema_json/description/annotations`; `MemoryRef.content`; `KnowledgeRef.snippet/title/score/source-range`; `RunBudgets` token/cost/wall-clock; `SearchKnowledge`; `SaveConversationSummary`; `CommitRunResult.usage` |
| Engine | Migrations 0031–0035 (instructions+model_params, `tool_catalog`, `conversation_summaries`+title, `message_feedback`, MESSAGE_ATTACHMENT/GENERATED_MEDIA); assistant schema v2 (`assertPublishable`, `assertToolPins` hash pinning); tool-catalog module; real `GetAuthorizedRunContext` assembly (summaries, memory content, ACL-before-scoring retrieval, tool schemas, budgets) with spotlighting + PII redaction (`src/common/guardrails/`); usage ledger entry in the CommitRunResult TX; feedback + title routes; SSE `delta` naming |
| Studio | ConnectRPC `RuntimeControlService` host (StartRun/Cancel/DeliverInput/Status/Drain, service-token auth, fail-closed prod); inline executor (claim → context → pure compile → LiteLLM streaming with coalesced AssistantChunk → tool authorize/record + approval propose-and-park → CommitRunResult w/ usage → compaction → lease release); real `compileContext` (was a `trigger:` stub); workflow fixes (real schemas, run.version CAS, model params, usage); MCP client v1.1 methods; `AssistantChunk` domain event |

---

## Phase FL-1 — Publish blockers (P0)

### FL-1.1 Parallel tool calls per turn — `CODE_COMPLETE` · P0 · Studio
- **Scope:** kernel/workflow + inline executor execute ALL tool calls the model proposes per turn, not `toolCalls[0]`.
- **Deliverables:** fan-out via Tool Gateway (READ_ONLY concurrent; MUTATING serialized in policy order), joined results appended as one bounded `tool` message per turn; per-call AuthorizeToolCall/RecordToolOutcome; budget counter per call.
- **Depends:** none. **Gate:** `E2E` multi-tool turn dedup + approval path for the mutating subset.

### FL-1.2 Budget, wall-clock and cost enforcement — `CODE_COMPLETE` · P0 · Studio
- **Scope:** honor `RunBudgets` (max_total_tokens, max_cost_micros, wall_clock_seconds) inside the run loop (inline executor + workflow) — today only turn/model-call counters are checked.
- **Deliverables:** token counter from stream `finish` usage per turn; wall-clock deadline check between turns (AbortController on breach); fail path emits `RunWarning` + `failRun('BUDGET_EXHAUSTED', …)`.
- **Depends:** none. **Gate:** unit tests across the three budget dimensions; `E2E` budget-exceeded run terminates with FAILED, not hang.

### FL-1.3 Cancellation propagation into in-flight provider calls — `CODE_COMPLETE` · P0 · Studio
- **Scope:** CancelRun must abort the in-flight gateway stream; today the provider call runs to completion.
- **Deliverables:** run-scoped AbortController registry in the inline executor + cancellation checks between turns; gateway `stream()/generate()` already accept signals — wire them; Temporal mode keeps signal-based flow.
- **Depends:** none. **Gate:** chaos test — cancel mid-stream, assert `CANCELLED` terminal state and no assistant message committed.

### FL-1.4 Runtime moderation + output guardrails — `CODE_COMPLETE` · P0 · Engine + Studio
- **Scope:** the guardrails module has spotlighting + PII redaction but **no moderation hook** (chat draft said PARTIAL — corrected: interface does not exist), and nothing screens assistant output before commit.
- **Deliverables:** Engine `common/guardrails/moderation.ts` — `ModerationHook` port (`classify(content) → {verdict, categories}`) with no-op dev impl + one production impl (provider moderation API or PromptGuard-2-class classifier behind `HARNESS__MODERATION_PROVIDER`); policy resolution from `guardrail_policy` strings; Studio consumes the hook on (a) user input at run start, (b) assistant output pre-CommitRunResult — block writes `run.guardrail_blocked` event + `failRun`; fail-closed in production when a configured hook is unavailable.
- **Depends:** none. **Gate:** `SEC` + negative tests (injected content blocked, availability failure fails closed in production mode).

### FL-1.5 `memory_scope` policy honored in the manifest — `CODE_COMPLETE` · P0 · Engine
- **Scope:** correctness. The pinned `context_policy.memory_scope` is ignored: `GetAuthorizedRunContext` includes organization + conversation scope only; `user`-scoped memories are never resolved to the participant account.
- **Deliverables:** resolve conversation participant (account) → include `memory_items` with `scopeType='user' AND scope_id = account` when policy is `user`; exclude memory surfaces entirely for `none`-equivalent policies; keep spotlighting/PII path.
- **Depends:** none. **Gate:** isolation tests across all four scope values (cross-user denial is the negative case).

### FL-1.6 Vision input end-to-end — `CODE_COMPLETE` · P0 · Studio (+Engine wiring)
- **Scope:** images attached to messages reach the provider as multimodal parts. Purposes/media types exist; the compiler never inlines them.
- **Deliverables:** manifest `BoundedMessage.artifact_ref` → Studio fetches via claim-check (bounded, media allowlist) → provider image parts in `providerRequest` (context-compiler `provider-format`); size/count caps per request; inline executor + workflow both path through the compiler.
- **Depends:** FL-1.2 (budget accounting for image tokens). **Gate:** `E2E` image-attachment run; negative: oversized/unknown media rejected before provider call.

### FL-1.7 Human handoff / live-agent takeover — `CODE_COMPLETE` · P0 · Engine (+UI later)
The #1 enterprise-chat capability (2026 buyer consensus: escalation quality benchmarks against 55–70% AI deflection). Schema supports `participantType='service'`; nothing else exists.

- **FL-1.7a Escalation data model — Engine — `CODE_COMPLETE`.** Migration `0037` (`0036` went to budget_policy, FL-1.2): `escalations` (org, conversation, reason, state `WAITING→CLAIMED→RESOLVED`, claimed_by, requested_at/claimed_at/resolved_at, sla_expires_at) + indexes; conversation status gains `escalated`; `MIG`+`RLS+`.
- **FL-1.7b Engine APIs + reply path — Engine — `CODE_COMPLETE`.** Escalate (user-facing + run-originated), queue list/claim/assign/resolve (console routes, OrgRolesGuard), human-agent reply via the ONE `acceptMessage` entry (participant `service`, rendered distinctly to the end user), escalation lifecycle outbox events (`conversation.escalated/claimed/resolved`) → SSE named events + channel outbound relay; `EXPLAIN` on the queue query.
- **FL-1.7c Handoff triggers — Engine + Studio — `CODE_COMPLETE`.** Built-in `request_human_handoff` tool in the catalog (effect class `MUTATING`, approval `NONE` — it escalates, not writes customer data); run-level escalation event → Engine escalation row; auto-escalation hooks (n-consecutive-negative-feedback, sentiment hook interface) behind flags.
- **FL-1.7d Pause semantics — Engine — `CODE_COMPLETE`.** While `escalated`, the assistant auto-responder pauses (run acceptance policy check), resumes on resolve; channel out-of-hours note reuses existing window policy.
- **Depends:** none internally. **Gate:** `E2E` full loop (user escalates → agent claims → agent replies over widget + a channel → resolve → assistant resumes) + `RLS+` on `escalations`.

### FL-1.8 H1a exit-gate run — `CODE_COMPLETE` (script + fixtures authored in `engine/ops/e2e/`; execution awaits authorization and the first full CI/DB run) · P0 · All
- Scripted end-to-end: assistant v2 (instructions+params+catalog tools) → message → manifest contains instructions/knowledge/memory/summary/tool schema → multi-tool turn (FL-1.1) → approval park/resume → streamed deltas observed → vision part (FL-1.6) → budget-cancel paths (FL-1.2/3) → moderation block (FL-1.4) → handoff loop (FL-1.7) → usage ledger exactly once. Joins the first full CI/DB run.

---

## Phase FL-2 — Parity wave (P1, immediately post-publish)

### Retrieval & knowledge
- **FL-2.1 Hybrid retrieval + reranker — `CODE_COMPLETE`** — Engine. PG FTS (tsvector) + pgvector in parallel → RRF fusion → cross-encoder reranker adapter (default off). Gate: recall comparison fixture, `EXPLAIN`.
- **FL-2.2 Re-embed pipeline — `CODE_COMPLETE`** — Engine. Embedding-model version on documents/chunks; background re-embed job (resumable, batched); swap reads atomically per document. Gate: zero-downtime reindex drill.
- **FL-2.3 Org embedding + chunking controls — `CODE_COMPLETE`** — Engine. Per-org embedding model + chunk size/overlap in knowledge config; ingestion honors it. `MIG`.
- **FL-2.4 Semantic memory search — `CODE_COMPLETE`** — Engine. pgvector on `memory_items` (embed at approval), similarity-ordered manifest selection. Gate: `RLS+`.
- **FL-2.5 Knowledge connectors — `CODE_COMPLETE`** — Engine. Connector framework (OAuth account link, scheduled incremental sync: Google Drive, Notion, Confluence, sitemap first) → upload-session pipeline. Largest FL-2 item; consider its own mini-ledger. 
- **FL-2.6 Ingestion: OCR, tables, audio/video transcription — `CODE_COMPLETE`** — Engine. Scanner/extractor ports gain OCR (scanned PDFs), table-aware chunking, Whisper-class transcription. Gate: fixture corpus.

### Search & chat UX
- **FL-2.7 Cross-conversation full-text search + auto-titles — `CODE_COMPLETE`** — Engine. tsvector generated column + GIN on messages (org-scoped, `RLS+`, `EXPLAIN`); title generation via Model Gateway on first exchange.
- **FL-2.8 Widget attachments + quick replies/CSAT — `CODE_COMPLETE`** — Engine + UI. Embed upload flow (existing purposes), `ChannelConfig` quick replies/CSAT, feedback widget binding to `message_feedback`.
- **FL-2.9 Citations plumbing — `CODE_COMPLETE`** — Engine + UI. Chunk offsets (already in contract) → assistant message `citation` content parts → widget/consumer source rendering.

### Tools & execution
- **FL-2.10 HTTP tool executor binding — `CODE_COMPLETE`** — Engine + Studio. Catalog entry → customer endpoint + scoped sealed credential (`enc:v1:`), per-tool rate limit/timeout; egress policy enforced.
- **FL-2.11 Sandbox spike → `code_interpreter` — `CODE_COMPLETE` (design decision + HTTP port; backend deploy awaits ops)** — Studio. E2B (self-host) vs Daytona vs Cloudflare Sandboxes against the failure-injection suite; pick one; first catalog tool (READ_ONLY, network-denied default).
- **FL-2.12 External MCP connectors — `CODE_COMPLETE`** — Engine + Studio. `connector_accounts` (OAuth token vault), Tool-Gateway adapter speaking MCP `2026-07-28` (stateless, `server/discover`, `ttlMs` schema caching); connector calls flow through AuthorizeToolCall + audit.
- **FL-2.13 Oversized tool results → claim-check — `CODE_COMPLETE`** — Studio. Wire the artifacts package into the loop: result > threshold → artifact + ArtifactRef in ToolResultBody.

### Context quality
- **FL-2.14 `output_schema` end-to-end — `CODE_COMPLETE`** — Contract + Engine + Studio. `ModelParams.output_schema` (additive), validation, compiler/provider structured-output pass-through.
- **FL-2.15 Prompt-cache preparation — `CODE_COMPLETE`** — Studio. Deterministic tool ordering, stable prefix layout, explicit cache breakpoints; document the invalidation interaction with FL-2.16.
- **FL-2.16 Tool-result clearing between turns — `CODE_COMPLETE`** — Studio. Clear consumed tool results once stable (Anthropic-measured lever); budget-aware.
- **FL-2.17 Resume-from-checkpoint — `CODE_COMPLETE`** — Studio. Rebuild loop state from the latest checkpoint on re-drive instead of from-scratch.

### Trust & enterprise
- **FL-2.18 BYOK — `CODE_COMPLETE` (LiteLLM virtual-key routing; per-org key delivery rides the run-capability channel per ADR-004)** — Engine + ops. Per-org LiteLLM virtual keys (sealed `enc:v1:`), org-scoped gateway routing, key-rotation runbook.
- **FL-2.19 Data residency / region pinning — `CODE_COMPLETE`** — All. Residency class on orgs → storage/provider routing constraints; publish-time validation.
- **FL-2.20 Injection/jailbreak corpus as a CI gate — `CODE_COMPLETE` (corpus authored; CI wiring joins the first full run)** — Engine + Studio. Shared corpus (engine fixtures + Studio `tests/security`), fails the merge on regression; ledger-gated.
- **FL-2.28 User-facing memory management — `CODE_COMPLETE`** — Engine. "What do you remember" read API + edit/delete per account (GDPR-friendly); audit-covered. (Placed here per chat list #35.)

### Data, evals & analytics
- **FL-2.21 Eval datasets + runs — `CODE_COMPLETE`** — Engine + Studio. `eval_datasets`/`eval_cases`/`eval_runs` tables (`MIG`+`RLS+`), Engine stores results (system of record), Studio eval-worker executes (tau2-style state verification + LLM-as-judge rubrics, `pass^k`).
- **FL-2.22 Feedback analytics consumer — `CODE_COMPLETE`** — Engine. Outbox consumer over `message.feedback.recorded` → CSAT/deflection aggregates.
- **FL-2.23 Conversation analytics rollups — `CODE_COMPLETE`** — Engine. Resolution/escalation/intent rollups (builds on FL-1.7).
- **FL-2.24 Cost rollup views — `CODE_COMPLETE`** — Engine. Usage-ledger views per assistant/version/conversation/day.

### Developer experience & channels
- **FL-2.25 L2 public API for conversations — `CODE_COMPLETE`** — Engine. API-key auth (`keys` module) on conversation create/message/SSE routes; OpenAPI published; rate limits per key.
- **FL-2.26 Lifecycle webhooks wiring — `CODE_COMPLETE`** — Engine. Emit conversation/run lifecycle events through the existing signed webhooks dispatcher (generic `dispatch` + HMAC exists); verify retry/backoff + delivery records.
- **FL-2.27 Outbound channel media — `CODE_COMPLETE` (WhatsApp + Messenger; Telegram/web media is a documented v1 non-goal)** — Engine. WhatsApp media + Messenger attachment senders (claim-check → provider upload), window policy preserved (C5 outbound half).

---

## Phase FL-3 — Frontier (P2; design doc before code unless noted)

| ID | Feature | Note |
|---|---|---|
| FL-3.1 | Voice (speech-to-speech, WebRTC) | CODE_COMPLETE (voice notes end-to-end: bounded media download → ASR port → acceptMessage + outbound TTS → WhatsApp voice note; realtime v2v/WebRTC stays a documented vendor seam) |
| FL-3.2 | Image generation output | CODE_COMPLETE (generate_image builtin → GENERATED_MEDIA claim-check artifact → EVENT_TYPE_MEDIA run event → refs pinned at commit → channel media delivery; endpoint deploy = seam) |
| FL-3.3 | Regenerate / edit-and-resend with branching | CODE_COMPLETE (migration 0042 branch pointers; regenerate + edit APIs; set-once supersede in the commit TX; immutable rows preserved) |
| FL-3.4 | Public share links, pinned messages, suggested follow-ups | CODE_COMPLETE (conversation_shares RLS + public token read; pin API; contract v1.2 suggested_followups end-to-end) |
| FL-3.5 | Built-in web search tool | CODE_COMPLETE (web_search builtin + HARNESS__WEB_SEARCH_URL) |
| FL-3.6 | Thinking/reasoning display events | CODE_COMPLETE (EVENT_TYPE_THINKING + Studio event + SSE naming) |
| FL-3.7 | Query rewriting (multi-query/HyDE) | CODE_COMPLETE (expand port + per-variant FTS legs fused via RRF; identity default, degrade-on-failure) |
| FL-3.8 | Retrieval eval sets (recall@k dashboards) | CODE_COMPLETE (expected.document_ids + live retrieval eval + mean recall@k route) |
| FL-3.9 | Temporal memory metadata (valid_from/invalid_at, supersession) | CODE_COMPLETE (migration 0041: valid_from/invalid_at/supersedes + validity predicates) |
| FL-3.10 | Auto memory-extraction policy after runs | CODE_COMPLETE (flag-gated auto-proposer consumer) |
| FL-3.11 | Pre-built tool template directory | CODE_COMPLETE (curated template registry + from-template catalog instantiation) |
| FL-3.12 | A/B / canary version rollout | CODE_COMPLETE (migration 0042 rollouts + sticky weighted pinning at acceptance + CRUD) |
| FL-3.13 | Online LLM-as-judge on sampled runs | CODE_COMPLETE (deterministic sampling consumer + run_judgments RLS table; judge endpoint = seam) |
| FL-3.14 | OTel GenAI agent spans completion | CODE_COMPLETE (gen_ai model spans at the gateway boundary with usage attrs + error paths) |
| FL-3.15 | TS/Python SDKs + published OpenAPI | CODE_COMPLETE (@neryva/sdk + neryva Py SDK + docs/public/openapi.l2.yaml) |
| FL-3.16 | Quickstart templates / sample apps | CODE_COMPLETE (products/samples quickstart-node + quickstart-python) |
| FL-3.17 | New channels (Instagram, X, email) | CODE_COMPLETE (platform CHECK widened; Instagram/X/email senders + webhook verification; OAuth apps + email provider = documented seams) |
| FL-3.18 | Interactive messages (buttons/lists) + template management UI | CODE_COMPLETE (WhatsApp interactive sender + channel_message_templates CRUD; management UI = consumer concern) |
| FL-3.19 | Inbound typing/read receipts | CODE_COMPLETE (message_receipts upserted from Meta statuses + widget read marker; typing endpoint ephemeral by design) |
| FL-3.20 | Prompt/response snapshots to audit | CODE_COMPLETE (claim-check model I/O refs; full transcript snapshotting deliberately off by default) |
| FL-3.21 | End-user chat export (PDF/Markdown) | CODE_COMPLETE (Markdown export route) |

---

## Deliberate non-builds (out of scope — do not accept PRs)

Importing MCP's tasks extension (our run/lease/approval model is strictly stronger) · LangGraph beside Temporal (dual durability) · building our own sandbox isolation tech (adopt E2B/Daytona/Cloudflare) · A2A interop before a customer requirement exists · Mem0/Letta/Zep as dependencies (memory policy layer stays Neryva-owned) · a second durable conversation or billing store anywhere in Studio.

## Execution order

1. **FL-1.1 → FL-1.3** (loop correctness; independent, parallelizable) → **FL-1.2** rides the same loop.
2. **FL-1.4 / FL-1.5** (Engine-side, parallel with 1).
3. **FL-1.6** (needs FL-1.2 budget hooks) → **FL-1.7** (largest; a–d in order) → **FL-1.8** gate run.
4. FL-2 in workstream order: retrieval (2.1–2.6) → context quality (2.14–2.17) → tools (2.10–2.13) → trust (2.18–2.20) → data/evals (2.21–2.24) → UX (2.7–2.9, 2.28) → DevEx/channels (2.25–2.27).
5. FL-3 strictly after FL-2 stabilizes, design-doc-first.

## Sources

Feature landscape research (2026-09-12): [ASAPP buyer's guide](https://www.asapp.com/hub/the-best-ai-agent-platforms-for-customer-service-a-2026-buyers-guide), [Fin AI](https://fin.ai/learn/best-ai-agents-customer-service), [Kore.ai](https://www.kore.ai/blog/top-ai-agents-for-customer-service-tested-reviewed), [Builts.ai](https://builts.ai/blog/ai-customer-service-trends-2026/), [OpenAI Realtime API](https://developers.openai.com/api/docs/guides/realtime), [Forasoft Realtime 2026](https://www.forasoft.com/blog/article/openai-realtime-api-voice-agent-production-guide-2026), [Deepgram voice APIs](https://deepgram.com/learn/top-apis-programmable-voice-agents), [Notion↔Drive connector](https://www.notion.com/help/notion-ai-connectors-for-google-drive), [Gemini Enterprise connectors](https://docs.cloud.google.com/gemini/enterprise/docs/connectors/notion), [Writer knowledge connectors](https://support.writer.com/articles/4599542578-setting-up-knowledge-graph-data-connectors) — plus the full protocol/research source list in `ai_harness_plan.md` §8 (MCP 2026-07-28, Anthropic context engineering, LlamaFirewall/spotlighting, tau2-bench, sandbox comparisons, AI SDK streams).
