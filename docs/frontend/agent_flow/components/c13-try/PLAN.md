# C13. Test run — PLAN (STATUS: FINAL 2026-09-18)

> SPEC: `engine/docs/frontend/agent_flow/components/c13-try/SPEC.md` (NOT STARTED).
> Ledger: `components/ledger_component.md` §C13 (lines 173–179).
> Every engine claim below was read firsthand on 2026-09-18. File paths are
> repo-root-relative (`neryva_studio/`), console paths prefixed `console/`.

---

## 1. Verified engine truth (file:line)

### 1a. Test-run route + bounds

- `POST :assistantId/versions/:versionId/test-runs`, roles owner/admin/developer,
  `@Idempotent()`: `engine/src/modules/assistants/assistants.controller.ts:215-233`.
- Controller validates the LOWER bound only (`trim().length === 0` → 400); its
  message text `is required (1..8192 chars)` over-claims
  (`assistants.controller.ts:229-231`). The UPPER bound is enforced in the
  service: empty or `> 8192` → 400 `must be 1..8192 chars`
  (`engine/src/modules/assistants/assistants.service.ts:1468-1471`).
  Console mirrors the bound client-side
  (`console/.../agents/detail/TestRunPanel.tsx:122-125`).
- `runKind: 'test'` pinned at accept (`assistants.service.ts:1491`); doc block
  `1441-1453` states no quota / no billing / invisible-to-users.

### 1b. Quota + billing exclusion (proven, not just commented)

- Quota reservation commits with the run ONLY for `'standard'`
  (`engine/src/modules/conversations/conversations.service.ts:444-450`).
- Usage-ledger insert (pricing + cache split + cost) is gated
  `run.runKind === 'standard'` (`conversations.service.ts:1586`).
- So for test runs: never reserves quota, never writes a ledger row, never
  bills. These three are the only cost claims the UI may state as engine fact.

### 1c. Draft executability

- Draft snapshot synthesized server-side before accept
  (`assistants.service.ts:1477` → `ensureVersionSnapshot`); test path is
  deliberately not one transaction (orphan test conversation harmless by
  construction, `1450-1452`).
- Test conversation created with `participantScope: 'org'`
  (`assistants.service.ts:1479-1484`); audit `assistant.test_run_started`
  (`1493-1501`).
- Console runnable filter today: `DRAFT` or `PUBLISHED`
  (`TestRunPanel.tsx:66`).

### 1d. Streaming transport (reuse, never rebuild)

- SSE endpoint `@Sse(':runId/events/stream')`, roles owner/admin/developer/
  **reader/billing** (`engine/.../conversations/conversations.controller.ts:337-346`);
  replay via `Last-Event-ID` header (authoritative engine_sequence).
- Console: `createSseParser` (`console/.../lib/engine/sse.ts:31-35`,
  reconnect/backoff + 401-refresh + visibility-pause documented `1-18`);
  `useEventStream` lifecycle wrapper with parked-while-disabled
  (`console/.../hooks/engine/useEventStream.ts:11-55`).
- Event taxonomy `parseRunEvent` → chunk/tool/usage/lifecycle/other
  (`console/.../hooks/studio/useChat.ts:108-164`); reference phase machine
  `useChatSession` — live overlay + notices + terminal finalize + 15s
  accepted-honesty + cancel + reset (`useChat.ts:279-403`).
- Existing panel consumes chunk-only and drops the rest
  (`TestRunPanel.tsx:78-84`); poll loop 3s × 30 rounds as durable backstop
  (`TestRunPanel.tsx:25-26,86-115`); silence-honesty copy + Status link
  (`TestRunPanel.tsx:194-200`).

### 1e. Stop lines (wall-clock proven, cost-stop NOT an engine bind)

- Watchdog sweeps RUNNING/DISPATCHED runs past `wall_clock_seconds > 0`
  (`engine/src/workers/run-watchdog.worker.ts:62-84`).
- `failRunForBudget` (`conversations.service.ts:2249-2341`): terminal
  `run.failed` event with `terminal_reason: 'budget_exceeded'`
  (`2284-2300`); row → `FAILED` (`2302-2312`); quota release via
  `settleRunQuota` (`2314-2316`); outbox `run.failed` (`2318-2329`); audit
  `run.failed` (`2330-2338`).
- **No engine cost-stop exists**: token/cost caps are handed to Studio for
  enforcement; no `failRunForBudget`-for-cost path. The SPEC's "SEPARATE
  lines" is therefore a UI-copy contract with only the wall-clock half
  engine-bound (see §8 D2). Corollary: quota-release for test runs is
  vacuous (never reserved) — never claim it released anything.

### 1f. Trace data availability (honest inventory)

- Tool + usage + lifecycle events parse today (`useChat.ts:150-159`); the
  panel drops them — C13 surfaces them, nothing new to invent.
- Guardrail verdicts are Studio-resolved; the engine records policy
  identifiers only (subagent-verified `mcp-authority.service.ts:1962-1964`,
  mode resolve `2001-2007` — firsthand re-check scheduled in build §5.2).
- Per-run retrieval excerpts/scores/version-pin state are NOT durably
  reported per run (subagent-verified, firsthand re-check in build); the
  trace renders citations ONLY from events that actually arrive
  (permissive parse, §5.4) — never synthesized.
- Causality highlighting: absent everywhere — stays barred.

### 1g. Reload / persistence

- The test thread IS engine-persisted (conversation + messages re-readable
  via `useConversationMessages`, `useChat.ts:168-177`), but `TestRunPanel`
  keeps `conversationId/runId/liveText` in `useState` only
  (`TestRunPanel.tsx:58-64`) — reload loses the pointer with no copy.
  C13 persists the pointer in the URL (`?try=<conversationId>`), restoring
  the thread from the server on reload.

---

## 2. Research synthesis (finding → decision)

> Web search was attempted 2026-09-18 (3 deep queries) but the provider
> returned rate-limit errors; one source fetched firsthand (MDN SSE). The
> findings below ground in MDN + the repo's own proven reference
> implementations (`useChatSession`, `ChatMessages`, `ChatComposer`), each
> mapped to a decision. No web claim ships without a source on the record.

- R1 (MDN, Using server-sent events — `id:`/`Last-Event-ID`/retry
  semantics): reconnect replays the identical tail; comment lines keep
  alive. → D: keep `useEventStream` verbatim; silence past the poll window
  is a PLATFORM state (Status link), never prompt-blame (already the
  panel's copy, kept).
- R2 (in-repo `useChatSession`, `useChat.ts:279-403`): live-overlay +
  transcript-as-record + terminal-finalize + notices is the proven shape.
  → D: new `useTrySession` mirrors that machine, version-pinned through
  `useTestRun` (`useAgentAuthoring.ts:463-474`, kept verbatim) instead of
  conversation-create.
- R3 (in-repo `ChatMessages`, `ChatMessages.tsx:23-182`): bubbles + role
  meta + notice pills (tool/usage/status/error tones) + typing indicator +
  regenerate/suggestions is the closest thread to the SPEC. → D: EXTEND —
  reuse `MessageList/Bubble/NoticeRow/TypingBubble + onRegenerate` for the
  Try thread; add a skeleton bubble + citation slot alongside, never a
  parallel bubble system.
- R4 (in-repo `ChatComposer`, `ChatComposer.tsx:24-139`): dock contract
  (`onSend/streaming/onStop/disabled + hint`, Enter-send, send↔stop swap).
  → D: Try input dock copies that contract multiline + version-pin
  context; no direct import (workspace copy + banner coupling differ).
- R5 (SPEC law + engine §1e): stop lines must read as what they are.
  → D: wall-clock stop renders `FAILED · budget_exceeded_wall_clock` with
  the watchdog reason; any cost/usage stop renders ONLY from a
  Studio-reported usage/lifecycle event, labeled as reported; the two are
  never merged into one "limit" line.
- R6 (advisory-vs-blocking): instructions-empty is advisory for try but
  REFUSES at publish (publish-only assert, re-verify in build). → D: amber
  whisper naming both ("Try runs without instructions — publish will
  refuse until you write them"), never a blocker, never silent.

---

## 3. Builder placement (slot, shortcut)

- `response` is a `SpineId`, not a `SlotKind` (audit: `slot-model.ts`
  response-spine; `BuilderInspector.tsx:80` `SLOT_PASS.response='C13'`;
  `SLOT_WHAT.response` = "The Try console — chunks, directive, tool calls,
  verdicts, cost." `BuilderInspector.tsx:93`; projector placeholder
  `projector.ts:478-492` "Not tried yet — Try lands in C13").
- The spine is always visible → **no new shortcut**. Registry stays closed
  (`AgentBuilder.tsx:374-432`: Esc/N/⇧K/T/G/B/E/S/⇧M/M/Delete); no lock-test
  change (C09 wrote the first; C13 touches nothing).
- Build: `TrySection` mounted on the response spine in `BuilderInspector`
  (same placeholder-fallthrough removal pattern as C06–C09) + projector
  `responseSlot()` grade (§6) + canvas renders the graded spine (no new
  node type — `SlotNode` already renders spines).

---

## 4. Pure model first (`builder/lib/try-model.ts` + test)

- `TRY_PROMPT_MIN/MAX = 1/8192` (bounds §1a; client trims, server is record).
- `TryPhase = idle|sending|streaming|accepted|done|error` (mirrors
  `useChatSession`, adapter §5.1).
- Prerequisite states: `no-runnable-version | no-usable-model |
  instructions-advisory | ready` with per-reason fix copy (Edit jumps
  reuse `BUILDER_STEP_ANCHORS`-style anchors — confirm path in build).
- Stop-line copy constants: `WALL_CLOCK_STOP_COPY` (FAILED +
  `budget_exceeded_wall_clock` + watchdog reason), `COST_STOP_COPY`
  (reported-only prefix), `SILENCE_COPY` (platform, + Status link —
  existing copy kept), `RELOAD_COPY` ("Thread restored from the server —
  the live tail replays from the last event.").
- Guardrail copy: `LOGGING_NOT_BLOCK_COPY` ("Logged, not blocked — this
  verdict never stopped the run").
- Trace honesty copy: `TRACE_HONESTY_COPY` ("What the run saw — not proof
  of why."), citation rule (render only reported hits).

---

## 5. Hooks (extend, never duplicate)

1. **New `useTrySession(agentId, versionId)` in `useChat.ts`** (mirrors
   `useChatSession:279-403`): `useTestRun` for start (kept verbatim,
   `useAgentAuthoring.ts:463-474`); `useEventStream` parked-while-no-run;
   FULL `parseRunEvent` consumption (chunk → live overlay; tool/usage →
   notices; terminal → finalize + transcript invalidate); `stop` via
   existing cancel mutation; `reset`/`re-ask` (re-send same prompt as new
   run on the SAME conversation — multi-turn thread, fixing today's
   single-turn reset `TestRunPanel.tsx:117-143`); URL `?try=` pointer
   persist + restore (§1g).
2. **Firsthand re-checks scheduled in build** (subagent-reported, must be
   cited before copy ships): guardrail policy-id-only
   (`mcp-authority.service.ts:1962-1964`, mode `2001-2007`); retrieval
   durable fields (`mcp-authority.service.ts:2486-2507`); publish-only
   instructions assert (`validation.ts:182-189`); `useModelAvailability`
   reuse point (C04 precedent `BrainPanel.tsx:124-133`).
3. No new SSE client, no new parser, no new query-key family (§11).

---

## 6. Projector + page deltas (grading truth table)

New `responseSlot()` grade (spine, usability only — try never gates publish):

| State | Status | Subtitle / hint |
|---|---|---|
| No runnable version (no DRAFT/PUBLISHED) | `locked` | "Save a draft first" |
| Runnable, never tried (this load) | `untouched` | "Not tried yet — run a prompt" (keeps today's hint) |
| Try in flight / last try done | `ready` | "Last try <relative time>" / streaming hint |
| Last try errored / wall-clock-stopped | `attention` | names the stop (`budget_exceeded_wall_clock`) |

- No bottom-action rule (try is advisory; publish gating is C14's).
- Canvas: graded spine only, no satellite leg, no node change.

---

## 7. Variants & gates (empty/loading/error/denied/conflict + roles)

- Empty: no runnable version (locked copy + "Save a draft" jump); empty
  thread (suggestion prompts, `ChatMessages` suggestions pattern).
- Loading: version list loading (skeleton); streaming pre-first-chunk
  (skeleton bubble — NEW, composed from `Skeleton/Skeleton.tsx:9-21`,
  never a full-pane spinner mid-thread).
- Error: 409 `conversation already has an active run` (named + "wait or
  stop the run", never a form error); provider error + manual retry
  (re-ask loop); poll-expiry silence (Status link, kept copy).
- Denied: run/start gated `setup:author` with `setupDeniedCopy` (panel
  precedent `TestRunPanel.tsx:54-56`); thread VIEW open to all roles —
  the stream endpoint itself allows reader/billing
  (`conversations.controller.ts:338`), so readers see the restored thread
  read-only, never a dead panel.
- Conflict/OCC: none (test writes no draft; `If-Match` untouched).
- Audit link: `assistant.test_run_started` exists (`1493-1501`) — thread
  header links the pre-filtered Audit view (README gate).

---

## 8. Corrections log (SPEC deltas found in Step 1)

- D1 (controller cite): SPEC `assistants.controller.ts:215-227` → actual
  handler spans `:215-233`; validation `:229-231` is lower-bound-only
  (message over-claims the range; service `:1468-1471` owns the upper
  bound). SPEC correction appended in build §C13.11.
- D2 (cost-stop): SPEC "cost-stop … as SEPARATE lines" has no engine-side
  cost-stop counterpart — token/cost caps enforce Studio-side. UI keeps
  two SEPARATE lines but the cost line renders only from Studio-reported
  events, labeled as such; the wall-clock line is the engine-bound one.
- D3 ("never user-visible"): no engine visibility flag/filter found —
  the engine comment claims it, code does not enforce it. UI states only
  the proven trio (no quota, no billing, draft intact) + "lives in the
  Try console"; invisibility is never promised.
- D4 (trace fields): per-run excerpts/scores/version-pin state are not
  durably reported per run — trace renders only arriving events
  (permissive parse), directive comes from the draft (labeled source),
  guardrail rows show policy + mode + reported verdict (logging never
  reads as block).
- D5 (thread restore): thread IS persisted; today's loss is a client
  pointer bug — fixed via URL param, with honest restore copy.

---

## 9. Dedicated surface plan (keep-vs-extend, gaps, non-goals)

- KEEP + EXTEND `TestRunPanel` (shell, version picker, `useTestRun`,
  SSE+poll dual, silence copy): add multi-turn thread (no reset-on-start),
  full-kind notices, regenerate/re-ask, `?try=` restore, prerequisite
  blocks (§4), shared trace drawer (§10), role-split run/view (§7).
- No new route. `AgentDetailView.tsx:343` mount kept.
- Gaps closed: single-turn reset, dropped tool/usage/terminal events, no
  citations, no skeleton, no retry, no restore, no prereq blocks, no
  Edit jumps.
- Non-goals (enterprise honesty): engine cost-stop line; causality
  highlighting; citations beyond reported events; usage/cost numbers for
  test runs (no ledger row exists — estimate link to Budget instead);
  publish gating from try results; multi-agent compare.

---

## 10. Explicit non-goals

See §9 +: no `Drawer` variants beyond the trace need; no chat-attachment
flow in the Try dock (text-only, 1–8192); no prompt-template library;
no try-history list endpoint (restore is per-thread via URL, history is
C15's observe surface reusing the same drawer).

---

## 11. Query-key + invalidation plan

- Read (single-source, existing families): `['studio','chat-messages',
  orgId, conversationId]` + `['studio','chat-runs', orgId,
  conversationId]` (`useChat.ts:168-188`); versions list (existing
  authoring keys) for runnable gating.
- Writes: `useTestRun` POST (idempotent, no cache write — pointer goes to
  the URL, transcript refetch is the record).
- Invalidate on terminal finalize: both chat families (precedent
  `useChat.ts:330-331`); on cancel likewise. No shared catalog/health
  cache touched. No new family.

---

## 12. Shortcut impact

None. Response spine needs no summon key (always visible); registry and
lock test untouched. (First shortcut-affecting pass remains C09.)

---

## Build order (§4 protocol)

1. `builder/lib/try-model.ts` + test (bounds/copy/phase/prereqs first).
2. `useTrySession` (+ `TestRunPanel` extend consuming it) + tests.
3. Shared common-UI `Drawer` (`src/components/common/ui/Drawer.tsx` +
   test — Modal's Esc/outside-close/focus-trap/scroll-lock contract
   reused; C10/C15 reuse, never fork) + trace drawer content + projector
   `responseSlot()` + tests.
4. `TrySection` (builder response spine) + styles + tests; placeholder
   removal in `BuilderInspector`.
5. Wiring: inspector case, projector deltas, URL restore, role split.
6. Gates once → SPEC flip + README + ledger (§1 row + §7 entry).
