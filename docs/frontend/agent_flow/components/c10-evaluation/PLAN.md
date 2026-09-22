# C10. Evaluation — PLAN (STATUS: FINAL 2026-09-18)

> SPEC: `engine/docs/frontend/agent_flow/components/c10-evaluation/SPEC.md` (NOT STARTED).
> Ledger: `components/ledger_component.md` §C10.
> Every engine claim below was read firsthand on 2026-09-18 (two subagent
> sweeps + direct reads). Paths repo-root-relative (`neryva_studio/`),
> console paths prefixed `console/`.

---

## 1. Verified engine truth (file:line)

### 1a. Evaluate route + decision

- `POST :assistantId/versions/:versionId/evaluate`, roles owner/admin/developer,
  `@Idempotent()` → `{ eval_run_id }`
  (`engine/src/modules/assistants/assistants.controller.ts:189-213`).
  Body: optional `dataset_id` / `environment` / `attempts_per_case`
  (`:197-210`); console mirror `useEvaluateVersion`
  (`console/.../hooks/studio/useAgentAuthoring.ts:477-494`, keys omitted-when-absent).
- Decision `BLOCK if any block / WARN if warnings / PASS`
  (`engine/src/modules/knowledge/eval.service.ts:798`). Inputs: critical
  failures `:700-706`; required checks `:710-730` (unevaluated → BLOCK,
  fail-closed); regression `:744-780`; thresholds → warnings `:790-797`
  (absent metric → WARN, never invented).
- States `pending|running|completed|failed` (`eval.schema.ts:64-65`);
  `completeRun` sets `completed` (`eval.service.ts:813-826`).
- Results stored on the run: `results: parsed` (`:817`) = worker report
  `{cases[] {case_id, attempt, passed, score, failure_reason≤512,
  response_excerpt≤512}, checks[] {name, passed}, critical_failures[],
  metrics, evaluators, model}` (`eval.service.ts:51-108`).
- Case def (write vocab): `input.text 1..8192`, `expected{contains,
  not_contains, state_assertions, document_ids}`, `rubric{instructions,
  min_score}` (`eval.service.ts:31-49`).
- Provenance assembled with everything a replayer needs
  (`eval.service.ts:800-811` → `assembleProvenance :960-1055`); stored on
  the run (`:819`) + `releasePolicyVersion` (`:821-824`).

### 1b. Gate semantics (publish + promotion)

- Publish order: no-op → `rejectBlockedContent` → `rejectUnmetRequiredChecks`
  → degraded (`assistants.service.ts:1589-1594`).
- BLOCK refuses publish: `evaluatePublishGate` + throw iff
  `gate==='blocked_content'` (`release-gate.ts:27-40,71-123`); message
  verbatim `:34-35`. Precedence: BLOCK wins over missing-PASS (`:13-18`).
- Required: empty → pass; else ONLY fresh PASS on THIS hash
  (`release-gate.ts:48-63`); refusal message verbatim `:60` (contains
  `required.join(', ')` — safe ONLY because non-strings are filtered first,
  `:96-98`).
- Gate lookup: latest completed non-shadow decision for rows whose
  version hash = content hash (`release-gate.ts:100-114`); latest wins,
  so a later PASS clears an earlier BLOCK (`:15-18`).
- Refusals are 409 verbatim: `throwGateRefusal` → `ApiError.conflict`
  (`release-gate.ts:121-123`; conflict = 409).
- Promotion gate is SEPARATE and inline: latest completed BLOCK per
  version row id refuses promotion, 409 with its own message
  (`rollouts.service.ts:123-135`).
- Content hash = `canonicalHash(normalized payload)` (policies +
  instructions/params/budget/brand); manifest hash is SEPARATE; gates stay
  content-hash keyed (`assistants.service.ts:1577-1582`).

### 1c. Shadow (never gates publish) + dedup + drift

- Publish gate + provenance verdict exclude `is_shadow`
  (`release-gate.ts:109-111`; `assistants.service.ts:1127-1135`).
  Badge copy per SPEC: "shadow — never gates".
- 24h dedup per version: recent shadow run → `{status:'deduped'}`, no row
  (`eval.service.ts:553-561`).
- No template dataset → `{status:'no_dataset'}` (`:562-565`); the drift
  worker notifies on ALL drifted outcomes incl. `no_dataset`
  (`model-drift.worker.ts:87-101`), paging owner+admin
  (`assistant.model_drift`, `:94-95`). Alert-first, no auto-rollback.
- Drift detect: ACTIVE pin vs live catalog — `entry_removed /
  entry_disabled / entry_changed`; catalog growth is NOT drift
  (`eval.service.ts:467-536`); hourly sweep (`model-drift.worker.ts:41`).
- Shadow runs: same state machine, `is_shadow` flag, `attemptsPerCase: 1`,
  actor `system:model-drift` (`eval.service.ts:566-574`).

### 1d. Datasets + no-dataset fix + drafts

- Org-level, unique `(organizationId, name)`; bounds name ≤128,
  description ≤2048 (`eval.schema.ts:19-32`); list cap 100
  (`eval.service.ts:210`); duplicate → 409 (`:152-154`).
- Routes: `/datasets` + `/evaluations` exist
  (`console/.../router/routes.tsx:472-476`); console reads
  (`useSetupEval.ts:1-27` contract doc — exact).
- Seeded convention `template:<slug>@<version>`
  (`eval.service.ts:577-602`; `assistants.service.ts:1056-1081`).
- No-dataset refusal MESSAGE verbatim, code 400 (not 422):
  `assistants.service.ts:1014-1024` throws `ApiError.validation`;
  `validation` = 400 (`api-error.ts:127-129`).
- Drafts evaluable: `isEvaluableVersionStatus` = DRAFT+PUBLISHED
  (`eval.service.ts:117-119`); `evaluateVersion` synthesizes the snapshot
  (`assistants.service.ts:1025-1030`, same fn as test runs); RETIRED refuses
  (`eval.service.ts:401-405`).
- Attempts clamped 1..5 (`eval.service.ts:383`); default 1
  (`assistants.service.ts:1035`); `environment` accepted but lossy
  (provenance hardcodes `environment: null`, `eval.service.ts:1047`).

### 1e. Roles + audit

- Evaluate/datasets-create/cases-add/runs-start/results-write:
  owner/admin/developer; datasets/runs/recall LIST +reader;
  promote/reject owner/admin (`harness-parity.controller.ts:27-145`
  per subagent read; console `useSetupEval.ts:192-208` comments agree).
- Audit: `assistant.eval_started` (`assistants.service.ts:1040-1052`);
  completion `template.version_evaluated` / `eval.run_completed`
  (`eval.service.ts:838+`).

### 1f. Console reuse points (firsthand)

- `useSetupEval.ts` full read: parsers `parseDatasets :46-67`,
  `parseEvalRuns :128-157` (drops `is_shadow` + `results` — C10 extends,
  never forks); `EVAL_KEY = ['studio','setup','eval']`; mutations keep
  + invalidate correctly; promote/reject exist with ZERO UI imports.
- `EvaluatePanel.tsx` full read: DRAFT+PUBLISHED filter `:95`; latest-wins
  `:103-108`; 10s/3min tracking `:111-122`; curated provenance grid
  `:244-277`; BLOCK/WARN/failed copy `:240-243`; template-seed hint
  `:180-185`. Gaps: no STALE banner (hash juxtaposition only `:255`),
  no-dataset toast-only, no re-run, no results breakdown, no shadow/drift.
- `EvaluationsView.tsx` full read: datasets/runs/recall ledgers `:110-219`;
  provenance dump `:228-261`; modals `:289-485`; honest-gap comment
  `:42-47`. `StartRunModal` PUBLISHED-only is INTENTIONAL (`:419-421`
  comment — drafts evaluate from the agent page). Gaps: no seeded badge,
  no filters/pagination, no re-run, no promote/reject, no shadow/drift/stale.
- `DatasetsView.tsx` full read: read-only browse + `datasetOrigin`
  seeded-vs-custom classifier `:21-27` (the ONLY one in UI) + fix-path
  copy `:45-49` + Evaluations deep-link. Gaps: no case counts (no
  endpoint), no attach CTA, no create.
- `PublishPanel.tsx:124-199`: gate rows render verbatim copy +
  strings-only required filter (`:125`) — C10 links here, never forks it.
- `TemplatesView.tsx:574-601` `ReleaseTab`: required checks render
  object-safe (`typeof check === 'string' ? check : JSON.stringify(check)`,
  `:590`) — the pattern C10 reuses for mixed `required[]`.
- Builder: `evaluation` closed kind (`slot-model.ts:15,76-83`, skippable,
  anchor `evaluation→evaluation :150`, shortcut `e`); projector case is
  an honest ghost (`projector.ts:606-609`, `verdict` edge unlit);
  inspector falls to the generic placeholder (`BuilderInspector.tsx:537-558`
  region + `SLOT_PASS.evaluation='C10'`); `kindDraftEmpty('evaluation') =
  false` (`AgentBuilder.tsx:64-66`).

---

## 2. Research synthesis (finding → decision)

> Web-backed 2026-09-18 (6 deep results + prior C10 directive research).
> Enterprise sources: aievals.co 4-band gates, aiarch.dev eval-harness-gate,
> Stuzhuk Lab harness, EvalGate concepts, Langfuse golden datasets,
> Galtea guide, AgentEval. Each finding maps to a concrete C10 decision;
> research never overrides §1 binds.

- R1 (bands, not thresholds — aievals.co): gates read deltas against a
  baseline in bands (ship/hold/investigate/block); binary thresholds
  pretend false precision. → D: render thresholds as NAMED bars with
  values (`task_success ≥ 0.8` from the template policy), regression
  bound as plain words ("score may not drop more than 0.02 vs previous
  published"); no invented indifference windows — the engine's bound IS
  the band.
- R2 (harness in the release path — aiarch.dev): offline deterministic
  always, judge on behavior change; frozen baseline; gate wired so the
  question is answered by a number before ship. → D: the builder section
  leads with the gate verdict (decision + staleness), never the score
  alone; publish/promote rows link to the exact refusal copy.
- R3 (severity by reversibility — n1n.ai): FATAL = irreversible action
  (block), RISKY = unconfirmed guess (investigate), MISSED/HARMLESS =
  acceptable. → D: BLOCK copy frames irreversibility ("BLOCKed content
  cannot publish or promote — resolve the critical failures");
  WARN copy frames investigation ("below bar but shippable unless
  required checks declare otherwise") — kept from EvaluatePanel.
- R4 (golden sets: frozen, versioned, production-grown, sliced, holdout;
  dataset fingerprint — Langfuse/EvalGate/Stuzhuk): scores comparable
  only on the same dataset state; discontinuity markers on methodology
  change. → D: provenance shows dataset hash + dataset id; STALE banner
  is the methodology-change guard (content hash moved); runs always name
  their dataset; seeded-vs-custom badge everywhere datasets appear.
- R5 (rescore/decouple generation from grading; incremental writes —
  n1n.ai): re-grading must not require re-running. → D: re-run repeats
  the SAME dataset id + attempts (stated), never a silent substitution;
  attempts clamp 1–5 surfaced, not silent.
- R6 (trace-per-case evidence; per-slice comparison — Stuzhuk/Galtea):
  regressions need case rows, not just a score. → D: failing-case
  anatomy rows (case_id + score + failure_reason + response_excerpt≤512
  stated as excerpt + attempt); NO input/expected text (no list endpoint
  — stated once, D8); required-vs-optional check split from
  results.checks × template required.
- R7 (drift: re-score baseline on schedule; vendor/index/user shifts —
  Zalt/Galtea): drift is change without code change. → D: drift alert
  block is amber and names the drifted alias + reason where readable;
  shadow rows carry the info/blue never-gates badge; deduped/no_dataset
  have no rows — the panel says where drift WOULD appear instead of
  faking a feed.

---

## 3. Builder placement (slot, shortcut)

- `evaluation` satellite kind (closed vocab, `slot-model.ts:15`);
  skippable (`:104`); shortcut `e` already bound (no change, no lock-test
  touch — C09 wrote the first and only one).
- Inspector mounts `EvaluationSection` on the kind case (same pattern as
  C06–C09 satellite mounts); placeholder + `C10 PASS` tag retire for this
  kind only.
- Quick path (satellite) vs manage path (libraries + detail) per the
  visual contract: section shows seeded-vs-attach state, latest decision
  + STALE banner FIRST, run + re-run, shadow/drift states, and link-outs.
  Full ledgers, filters, modals stay in the dedicated surfaces.

---

## 4. Pure model first (`builder/lib/eval-model.ts` + test)

- `EVAL_ATTEMPTS_{MIN,MAX} = 1/5` (bind §1d; clamp helper shared wording).
- `isStaleRun(runHash, versionHash)`: both non-empty and unequal → stale.
  Pure string compare — the gate's own keying, no derivation.
- `describeDecision(decision)`: PASS/WARN/BLOCK → {tone, headline, detail}
  with R3 copy (BLOCK irreversibility, WARN investigate, PASS clears —
  "a later PASS clears any earlier verdict" kept from PublishPanel).
- `describeRequiredCheck(check)`: string → verbatim; object →
  `regression_no_worse_than: N` → "score may not drop more than N vs
  previous published" (ReleaseTab `:590` precedent); unknown objects →
  JSON (never `join` verbatim — C11 depends on this too).
- `describeDatasetOrigin(name)`: seeded `template:<slug>@<version>` →
  "Seeded by slug@version"; else "Custom" (DatasetsView `:21-27`
  precedent — import the fn, don't duplicate it).
- `gradeEvaluation({hasRuns, running, latest})`: truth table §6.
- Copy constants: `STALE_COPY` ("PASS on {a} · draft now {b} → Stale
  decision" + re-run), `SHADOW_COPY` ("shadow — never gates"),
  `NO_DATASET_COPY` (400 fix text + three paths), `DRIFT_COPY`,
  `NO_CASE_LIST_COPY` (D8 honesty), `PUBLISH_LINK_COPY`.

---

## 5. Hooks (extend, never duplicate)

1. **Extend `parseEvalRuns`** (`useSetupEval.ts:128-157`): add `isShadow`
   (bool, default false) + `results` (unknown record|null, default null)
   + `environment` (string|null). Same query, same key — additive fields
   the wire already returns (`listRuns` selects full rows). Pure
   sub-parsers `parseEvalResults` (cases/checks/critical/metrics per
   §1a shapes, tolerant) + tests. No new family.
2. **No new mutations**: `useEvaluateVersion` (version-scoped, drafts OK)
   for builder + detail run/re-run; `useStartEvalRun` for the library
   modal (unchanged); datasets/cases/recall untouched.
3. **No-dataset fix path without hook surgery**: `useEvaluateVersion`
   returns the mutation object — the component reads `evaluate.error`
   (ApiError: status + details) and matches 400 + `dataset_id` key →
   inline fix panel (Create dataset / Install template → templates link /
   Open Datasets). Toast still fires (hook-owned); the panel is additive.
   → Build re-check: ApiError field shape (`api-error.ts`, client error
   mapping) before matching on it.
4. **Stale inputs**: version hash — builder from context (already there);
   detail from `versions` prop row hash. Run hash — latest completed
   non-shadow run's `provenance.definition_hash`.
   → Build re-check: `assembleProvenance` definition_hash provenance
   (does it equal the version content hash? read `:960-1055`).
5. **Drift alert source** → Build re-check: `useNotifications` hook shape
   (filter `assistant.model_drift` for this assistant?) — if unreadable,
   the alert block states the paging truth without faking a feed (R7).
6. **Required checks read**: `useAssistantTemplate(slug, version)` —
   same call PublishPanel makes (`PublishPanel.tsx:87`); slug/version
   from `useVersionProvenance` (already used by EvaluatePanel `:101`).
   Strings + objects rendered per §4 (ReleaseTab precedent).

---

## 6. Projector + page deltas (grading truth table)

New `evaluationGrade()` (satellite usability + gate signal — NOT a publish
gate itself; C14 owns the ceremony):

| State | Status | Subtitle / hint |
|---|---|---|
| No runs for this version | `untouched` | "No eval runs yet — evaluate to earn a verdict" |
| Run pending/running | `info` | "Evaluating…" |
| Latest completed BLOCK (fresh) | `attention` | "BLOCKed — resolve and re-evaluate" |
| Latest completed WARN (fresh) | `attention` | "WARN — shippable unless required checks declare" |
| Latest completed PASS (fresh) | `ready` | "PASS on {hash8}" |
| Latest superseded by draft edit (stale) | `attention` | "Stale decision — re-run" (FIRST in section too) |
| Latest is shadow-only | `info` | "Shadow observations only — never gates" |

- Input: `ProjectorInput.evalState?: { hasRuns, running, latest: {decision, stale, shadow} | null }`.
  Undefined = unknown → keep today's ghost (`Datasets land in C10` dies
  with the pass — replaced by graded copy).
- `verdict` edge lights when a fresh PASS exists (first lit verdict leg).
- No bottom-action rule (C14 owns publish gating; the section links to
  PublishPanel instead of duplicating refusal copy).
- → Build re-check: `SlotStatus` members before adding new ones
  (reuse `info/attention/ready/untouched` — verify firsthand).

---

## 7. Variants & gates (empty/loading/error/denied/conflict + roles)

- Empty: no evaluable version (retired-only truth kept); no datasets
  (create CTA); no runs (evaluate CTA); no cases (add-only stated, D8).
- Loading: versions/datasets/runs skeletons (QueryView precedent).
- Error: 400 no-dataset → inline fix panel (three paths), never a dead
  end; 409 publish/promote refusals render VERBATIM (gate contract —
  PublishPanel precedent, linked not forked); run `failed` → re-evaluate
  copy (kept).
- Denied: run/create/add gated `setup:author` with `setupDeniedCopy`
  (precedents everywhere); lists readable by reader (engine allows —
  panels stay visible read-only, never dead).
- Conflict/OCC: evaluate POST is idempotent, no draft write — no 412
  surface. Deduped shadow runs have no rows — never a "missing run" error.
- Audit: `assistant.eval_started` exists — thread/panel header links
  `/platform/audit` (README gate; no pre-filter claim — page has no URL
  filters, C13 precedent).

---

## 8. Corrections log (SPEC deltas found in Step 1)

- D1 (status code): SPEC "422 with the fix" → engine emits **400**
  (`ApiError.validation` = 400, `api-error.ts:127-129`). Every "422" on
  this path (SPEC, CasesModal copy, harness docblock) is stale. UI copy
  never names the code — it names the fix.
- D2 (promotion gate): SPEC "BLOCK refuses publish AND rollout
  promotion" holds, but the promotion gate is a SEPARATE inline lookup
  per version row id (`rollouts.service.ts:123-135`) with NO shadow
  exclusion — a shadow BLOCK would stop promotion while publish ignores
  it. UI states the publish truth; promotion copy defers to Operate
  (C15) and never claims shadow-safety there.
- D3 (hash): gate keys the CONTENT hash; manifest hash is separate
  (`assistants.service.ts:1577-1582`). Stale compares content hashes.
- D4 (case shape): results carry `response_excerpt` (≤512), NOT `actual`;
  `rubric` is case-side. Anatomy rows show excerpt-as-excerpt +
  failure_reason; "actual output" is never claimed.
- D5 (required objects): `{regression_no_worse_than}` objects skip the
  check loop and bind as the regression bound (`eval.service.ts:710-743`);
  the gate filters non-strings then joins (`release-gate.ts:96-98,60`).
  UI renders strings verbatim, objects in plain words / JSON — never the
  engine join on mixed arrays.
- D6 (environment): accepted end-to-end but provenance hardcodes null
  (`eval.service.ts:1047`). UI never shows an environment from
  provenance; the attempts/environment echoes come from the START form,
  labeled as requested.
- D7 (stale docblock): `assistants.service.ts:992-997` says
  PUBLISHED-only/DRAFT-rejected — contradicted by the R-2 comment below
  it and `startRun`. Drafts evaluate; the comment is wrong, the code is
  right.
- D8 (case inputs): no case-LIST endpoint exists — failing-case rows
  show `case_id` + score + failure_reason + excerpt + attempt, never
  input/expected text. The edit loop is "add a covering case → re-run"
  (CasesModal exists). Stated once in the UI, logged here.
- D9 (promote/reject): hooks exist, zero UI imports — and no candidate
  LIST endpoint exists to source case ids. They stay unwired with the
  reason stated (no dead buttons); re-opens if the engine adds the read
  path.

---

## 9. Dedicated surface plan (keep-vs-extend, gaps, non-goals)

- **EvaluationsView KEEP + EXTEND**: seeded badge column (reuse
  `datasetOrigin`), decision/state pills kept, row re-run (same dataset
  + attempts, stated), results drawer per run (required-vs-optional +
  failing-case anatomy from `results`, shared component with detail —
  see §10), decision/state filters + pagination honesty (server cap 100
  stated; client filter over the 100), provenance copy button (values
  truncate — copy full), attempts clamp labeled. Recall kept as-is.
  StartRunModal kept (PUBLISHED-only by design — comment kept, draft
  entry lives on version surfaces).
- **DatasetsView KEEP + EXTEND**: origin pills kept, attach CTA
  (`Use in evaluation →` deep-link to Evaluations), create entry
  (same modal contract as EvaluationsView — shared `DatasetModal`?
  verdict in build: extract only if byte-identical needs; else link
  "Create in Evaluations →"), per-dataset runs link (runs filtered by
  dataset — `useEvalRuns(datasetId)` already supports it).
- **EvaluatePanel KEEP + EXTEND**: STALE banner FIRST, no-dataset fix
  panel, one-click re-run (same params), results breakdown (shared
  component), shadow badge on shadow rows (version filter must STOP
  dropping them — today `versionRuns` includes shadows silently; badge
  them, never hide).
- Non-goals (enterprise honesty): case browser (no endpoint, D8);
  promote/reject wiring (no endpoint, D9); methodology editing
  (thresholds/criticals live in template policy — C11); judge config
  surfaces; cost/latency bands (no engine numbers); publish ceremony
  (C14); rollout promotion UI (C15).

---

## 10. Explicit non-goals

See §9 +: no new SSE/streaming (runs poll like today); no evaluation
history chart (scores across runs need no new endpoint but are C15
observe territory — link, don't build); no dataset delete (no endpoint
seen — never claim it); no environment display from provenance (D6);
no 422 copy anywhere (D1 — including fixing the CasesModal "per-index
422s" line if touched… it is NOT touched: C10 edits that file only if
the shared fix-path work requires it. Correction: the CasesModal copy
fix ships ONLY if CasesModal is otherwise edited; else logged).

---

## 11. Query-key + invalidation plan

- Read (single-source, existing family): `['studio','setup','eval',
  orgId, 'datasets']`, `[..., 'runs', datasetId|null]`
  (`useSetupEval.ts:33,69-78,159-171`). Builder + detail + libraries
  share these caches — no new family, no second derivation.
- Writes: `useEvaluateVersion` (invalidates AUTHORING only) → callers
  with runs visible invalidate `[...EVAL_KEY, orgId, 'runs']` after
  success (EvaluatePanel already refetches manually — keep pattern,
  extend to the section); `useStartEvalRun`/dataset/cases mutations
  already invalidate correctly.
- Polling: in-flight runs refetch on the EvaluatePanel 10s/3min pattern
  (kept, extended to the section while a tracked run is open).

---

## 12. Shortcut impact

None. `e` summons evaluation already (`AgentBuilder.tsx:439`); no new
keys, no moves. Lock test untouched (C09's stand).

---

## Build order (§4 protocol)

1. `builder/lib/eval-model.ts` + test (bounds/copy/stale/decision/
   required/dataset-origin/grade first).
2. `useSetupEval.ts` extend (isShadow/results/environment + results
   parsers) + tests. Build re-checks: ApiError shape, provenance
   definition_hash, notifications drift source, SlotStatus members.
3. Shared `EvalResults.tsx` (results drawer content: required-vs-optional
   + failing cases + provenance + shadow badge + stale banner) + test —
   detail + library reuse, never fork.
4. Projector `evaluationGrade()` + `evalState` input + tests.
5. `EvaluationSection` + styles + tests; placeholder retirement in
   `BuilderInspector`; `AgentBuilder` deltas (evalState, no new shortcut).
6. Dedicated extends: EvaluatePanel (stale-first, fix-path, re-run,
   results) + EvaluationsView (badge, re-run, results drawer, filters,
   copy button) + DatasetsView (attach CTA, runs link) + tests.
7. Gates once → SPEC flip + README + ledger (§1 row + §7 entry).
