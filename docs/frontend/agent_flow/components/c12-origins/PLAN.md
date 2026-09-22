# C12. Origins — PLAN (STATUS: FINAL 2026-09-18)

> SPEC: `engine/docs/frontend/agent_flow/components/c12-origins/SPEC.md` (NOT STARTED).
> Ledger: `components/ledger_component.md` §C12.
> Every engine claim below was read firsthand on 2026-09-18 (two subagent
> sweeps + direct reads). Paths repo-root-relative (`neryva_studio/`),
> console paths prefixed `console/`.

---

## 1. Verified engine truth (file:line)

### 1a. Clone — NO endpoint (SPEC transport CORRECTED, behavior holds)

- No `POST .../clone` exists (full controller route list
  `assistants.controller.ts:15-327` has none; no `clone()` in the service).
- Actual clone = client composition (`useCloneAssistant`,
  `console/.../useAgentAuthoring.ts:525-558`): GET versions + GET
  assistant → prefer DRAFT ?? active (falls back to blank) → POST
  `/assistants {name, description?, definition: toEnginePayload(def)}`.
- Transport = create: new assistant + new DRAFT row (`version: 0,
  status: 'DRAFT'`, `assistants.service.ts:149-150`); source row never
  touched → original untouched. Name default `"${name} (copy)"`
  client-side (`:541`); rule 2–128 (`dto.ts:29`, `service :1952-1955`);
  collision 409 (`service :1937-1941`). Roles owner/admin/developer
  (`controller :16-17`).

### 1b. Import — existing assistant's DRAFT child (SPEC target CORRECTED)

- `POST :assistantId/versions/import` (`assistants.controller.ts:278-295`,
  roles owner/admin/developer `:278-280`, `@Idempotent() :281`) →
  `importVersion` (`assistants.service.ts:1190-1239`) → returns
  `{version}` (`:294`). Creates a DRAFT child on the EXISTING assistant
  (`requireAssistant` via `createVersion :339`) — never a new assistant.
- Request = envelope at TOP level (`ImportVersionDto :208-250`;
  `controller :285,291` passes `dto as exported` — NOT `{export:}`).
  The detail UI pastes raw export files (`{export,provenance}`) today →
  deterministic 400 (confirmed gap — the pane unwraps `.export`).
- Envelope (11 keys, `service :1170-1182`): `schema_version,
  instructions, model_params, budget_policy, brand, model_policy,
  context_policy, tool_policy, knowledge_policy, guardrail_policy,
  hash`. `schema_version` number-checked only (`:1199-1205`, current 2
  per `schema.ts:294`) — never equality-checked, never migrated.
- `hash + schema_version` stripped pre-compare (`:1217`), null-stripped
  (`:1218-1220`), zod-parsed (`:1221-1226`), `hashPayload` =
  canonicalHash sorted-keys sha256 (`:1227`, `:1958-1960`) vs the
  `hash` field — mismatch → 400 (`:1228-1232`); then `createVersion`
  (`:1233-1238`, which re-enforces unknown-keys + payload + secrets
  `:348-352`).
- Export mirror: `GET .../versions/:versionId/export` → `{export,
  provenance}` (`controller :263-276`, `service :1158-1183`); roles
  +reader/billing (`:263-265`); DRAFT export → 404 (`:1167-1169`).
- No-op: same content + no draft → SUCCESS new DRAFT (identical hash,
  no dedup in `createVersion :365-404`); same content + existing draft
  → 409 `draft_exists` (`service :1943-1947`).
- ALL validation errors are **400** (`ApiError.validation`), never 422
  (same D-correction as C10/C11); collisions 409; secret check runs
  inside `createVersion` (hash-mismatch fires first on import);
  idempotent transport but the console mints a fresh key per call
  (`client.ts:232-234`) — no cross-call dedup (double-click = two
  drafts; the pane disables while pending).

### 1c. Contract caps the client mirrors (engine + tighter contract)

- Engine (`validation.ts` + schema): temperature 0–2, max_output
  1–200000, top_p (0,1], reasoning enum, output_schema ≤16384 JSON
  object, strict; budget tokens 1000–2M / micros 0–1T / wall 0–86400 /
  tools 0–1000 / models 1–200; instructions ≤32768 optional (required at
  publish); brand ≤2000; models 1–20; history 1–100; summary default
  true; knowledge unbounded; memory 4-scope default user; tools ≤50,
  name 1–64, read|write, required|optional, schema_hash 64hex,
  live|shadow; knowledge max_results 1–20 default 5, retrieval default
  false; guardrails input/output min-1 + defaults, pii default true,
  blocking|logging; name 2–128, description ≤512; unknown-keys dotted
  (`validation.ts:201-238`); secrets (`:128-168`).
- Tighter-wins contract (`v1.schema.json`): models 16, tools 32,
  pins 16, instructions 20000 — the values `checkDefinitionCaps`
  already enforces (`setup-caps.ts:22-48,101-199`, dotted `CapIssue`
  paths, `sectionOf` mapping, secrets scan). C12 REUSES it directly.
- Consumer-only keys (`max_context_tokens`, retrieval display) never on
  wire (`agent-payload.ts:18-22,68-94`) — engine would 400 them.

### 1d. Console reuse points (firsthand)

- `useCloneAssistant` (`:525-558`): `name?` override already supported
  (identity resolution hook-ready); invalidates AUTHORING. Callers:
  PurposeInspector build button (`:131-152`, no picker/name/warning,
  `onCreated` → build path), detail header (`AgentDetailView:203-224`
  → edit path), list row menu (`AgentsView:278-288` → edit path).
  Landing inconsistent, none draft-highlights — unified in §9.
- `useImportVersion` (`:509-522`): opaque payload, toast-only errors.
  Sole caller `VersionsPanelActions` (`AgentDetailView:396-491`):
  paste-only modal, JSON-syntax toast only, no unwrap, no validator, no
  schema line, no highlight landing.
- `VersionsPanel` (`:493-626`): rows with status pills, compare toggle,
  per-version export, publish/retire; `DiffModal` dotted-path display
  precedent (`:628-661`).
- `useAssistants` list (`useAssistants.ts:10-82`): name (search),
  derived status (pill), updatedAt (sort), activeVersionId, degraded —
  everything the clone picker needs; `model` always null (never shown).
- `OriginScreen` (C11): blank vs template paths; `origin` state
  `'choose'|'blank'` extensible to clone/import without route change.
- Validation precedents: `buildCase` pure validator + per-index errors
  + JSON preview (`eval-cases.ts`, CasesModal); `checkDefinitionCaps`
  dotted paths + `sectionOf`; KnowledgeView Files|Paste tabs + hidden
  file input + `checkSourceSlug` inline errors; InstallWizard modal
  (name + inline error + outcome `role=alert` + landing).
- Warn-once precedents: `activation.ts` session mark-once (only true
  once-per-session primitive); `NotificationsPopover` localStorage
  dismissed set. Clone warning uses the latter (persistent dismiss;
  educational, not per-session).

---

## 2. Research synthesis (finding → decision)

> Web-backed 2026-09-18 (6 deep results). Sources: saasui destructive
> patterns, NN/g confirmation dialogs, shadcn duplicate-record,
> flexprice/nocobase duplication, Updog/Ivandt/Bootstrapware/UIforSaaS
> importers, Metabase serdes incidents, Ciaren flow import, rocky state
> schema, Lavar/interior new-item pills, OTF owned-templates. Each maps
> to a C12 decision; research never overrides §1 binds.

- R1 (friction ladder — saasui/NN/g): match friction to blast radius;
  clone is REVERSIBLE (creates, deletes nothing) → light confirm with
  specific copy (name the object + consequence), verb-labeled buttons,
  safe default, never type-to-confirm, never generic "Are you sure".
  → D: picker confirms with "Clone X as Y? The original is untouched —
  edits land on the copy." + [Clone agent] (verb) + easy cancel/Esc;
  warn-once checkbox for the education (NN/g #8 bypass for routine
  confirmations).
- R2 (duplicate dialog — shadcn/flexprice/nocobase): source summary +
  editable identity pre-filled + unique validation client-side + 409
  recovery + permission-gated entry + audit link. → D: picker shows
  source row (name/status/updated) + name field (default
  `"${name} (copy)"`, 2–128, `suggestRename` on 409) + denied copy for
  viewers + audit link on success.
- R3 (import pipeline: Upload → Validate → Import; client-first inline
  errors; failed-row context — Updog/Ivandt/UIforSaaS/Bootstrapware):
  parse + validate in browser, per-issue inline list, fix-in-place loop,
  submit only clean data. → D: Files|Paste tabs (KnowledgeView
  structure); `validateImportPayload` pure module (buildCase shape)
  returning `{path,message}[]` dotted mono list + JSON preview;
  Import-as-draft disabled until zero errors (warnings don't block).
- R4 (schema versions: refuse/resolve loudly, never silently mis-parse
  — Metabase/Ciaren/rocky): stamp-checked before writes; migrate or
  refuse with both versions named; non-blocking "will be upgraded"
  notice where migration exists. → D: OUR engine neither migrates nor
  refuses (number-check only) — so the pane DISPLAYS `schema_version`,
  warns amber when ≠ 2 ("validated as-is — review after import"), and
  never blocks on it (blocking what the engine allows would be a lie).
  Unknown top-level keys strip with stated warnings (engine zod-strips
  pre-hash — mirror it, don't invent refusal).
- R5 (landing highlight: one primary badge, consistent, expiring —
  Lavar/interior): fresh things get ONE attention signal where they
  land; it must not stay forever. → D: import lands with the new draft
  row pulsed + scrolled into view + "Imported as draft" banner (session
  state, not persistent); clone lands on the build path with a named
  toast (existing navigation unified — all three entries → build).
- R6 (owned templates: sections/CTA/analytics in source, agents edit
  second — OTF): new-from-import in new-mode composes POST assistants
  `{name, definition}` (same create transport as clone — one pipeline,
  two entries, R8 from C11).

---

## 3. Builder placement (host decision with options — decided)

- Clone picker: SHARED modal, three mounts (builder PurposeInspector
  button, detail header button, agents list row menu). No new route.
  Replaces one-shot clone clicks everywhere (same hook, picker feeds
  `name`).
- Import pane: TWO mounts —
  (a) detail `VersionsPanelActions`: extend the existing modal into
  Files|Paste tabs + validator + schema line + highlight landing
  (import targets THIS assistant — identity fixed);
  (b) builder new-mode `OriginScreen`: third + fourth cards
  (Clone / Import). Clone needs no assistant (picker lists org).
  Import in new mode = validate + identity name + POST assistants
  `{name, definition}` ("new agent from import", R6) → build path.
  Exact host verdict: NO import on the agents list/overview (detail +
  builder cover creation + existing; list stays a picker launcher via
  its row menu).
- No new SlotKind, no spine change, no canvas change, no shortcut.
  Origin state extends to `'choose'|'blank'|'clone'|'import'` — panels,
  not routes.

---

## 4. Pure model first (`builder/lib/origin-model.ts` + test)

- `parseImportText(raw)`: JSON.parse wrapper → `{json}` or
  `{syntaxError}` (friendly message, never the raw SyntaxError).
- `unwrapExportEnvelope(json)`: `.export`-object → `{envelope,
  wasWrapped: true}` (+ "unwrapped .export — provenance stays in the
  file" note); else `{envelope: json, wasWrapped: false}`.
- `extractSchemaVersion(envelope)`: number | null (display only).
- `validateImportPayload(json)`: `{definition: ConsumerDefinition,
  issues: ImportIssue[], schemaVersion: number | null, strippedKeys:
  string[], wasWrapped: boolean}` where `ImportIssue = {path, message,
  severity: 'error'|'warning'}` (CapIssue-compatible + severity):
  - unknown top-level keys (outside the 11-key envelope vocab) →
    warning + STRIPPED before send (engine zod-strips pre-hash — mirror);
  - consumer-only keys → warning + stripped (would 400);
  - `fromEnginePayload` → `checkDefinitionCaps` → errors (blocks send);
  - secrets → errors (existing scan, `secrets` path);
  - schema_version ≠ 2 (or missing) → warning (display + review
    prompt, never a block — R4);
  - empty-models / nameless-tool mapper throws (`toEnginePayload`
    programmer-errors) → surfaced as errors with paths, never raw.
- `describeCloneTarget(source)`: picker row copy (name/status/updated).
- `CLONE_WARN_KEY = 'neryva.clone-copy-warning.dismissed'`
  (NotificationsPopover shape) + `shouldShowCloneWarning()` /
  `dismissCloneWarning()` with private-mode try/catch
  (useSidebarPrefs precedent).
- `isDraftExistsError(error)`: 409 + draft-exists signal → whisper
  "a draft already exists — publish or retire it first" (verify message
  text in build: `assistants.service.ts:1943-1947`).
- Copy constants: `CLONE_COPY` (untouched-original, verb button,
  409-rename recovery), `IMPORT_COPY` (client-first, unwrap note,
  schema review, landing promise), `HIGHLIGHT_COPY` ("Imported as
  draft — review then publish").

---

## 5. Hooks (extend, never duplicate)

1. **No new mutations**: `useCloneAssistant({name})` feeds the picker;
   `useImportVersion(payload)` sends the STRIPPED envelope;
   `useCreateAssistant({name, definition})` powers new-mode import
   (R6). All invalidate AUTHORING already.
2. **No validator duplication**: `checkDefinitionCaps` +
   `fromEnginePayload`/`toEnginePayload` + `suggestRename`/`isNameValid`
   (inspector `purpose-model.ts:7-27`) reused; C12 adds only envelope
   handling + severity shaping (§4).
3. **`useAssistants` feeds the picker directly** (name/status/updated;
   `model` never shown — always null). No fan-out reads (no per-row
   definition fetch — the clone hook reads the source at submit).
4. **Warn-once storage**: localStorage dismissed-set
   (NotificationsPopover precedent) — no new idiom.

---

## 6. Projector + page deltas

- NONE. Origins are pre-circuit (origin screen) and post-action
  (navigation + highlight). No slot, no grade, no edge, no bottom-action
  rule. (C11 established templates as origin-only; C12 matches.)

---

## 7. Variants & gates (empty/loading/error/denied/conflict + roles)

- Empty: no assistants to clone (org of one — picker states it, offers
  import instead); empty file / empty paste (disabled Import, named).
- Loading: assistants list skeleton (QueryView); file read is instant
  (FileReader — errors named: unreadable file, not JSON).
- Error: JSON syntax → friendly message (no toast-only); validation
  issues → inline dotted list grouped by section (`sectionOf`); server
  400s render verbatim (unknown-keys dotted — the client pre-check
  should have caught them; mismatch is logged); 409 name-taken →
  one-tap `suggestRename` recovery (C01 pattern); 409 draft-exists →
  publish-or-retire whisper; secret hit → `secrets`-path row (never the
  credential).
- Denied: picker/modal entries gated `setup:author` + denied copy;
  export stays +reader (existing per-row buttons kept).
- Conflict/OCC: import POST is idempotent transport, but the console
  mints fresh keys per call → the pane disables while pending
  (double-click = two drafts otherwise — stated in code comment).
- Audit: clone via create path (existing audit) + import (existing) —
  success rows link `/platform/audit` (README gate; no pre-filter claim).

---

## 8. Corrections log (SPEC deltas found in Step 1)

- D1 (clone transport): no `POST .../clone` exists — clone is client
  composition (GETs + POST assistants). Behavior binds (new assistant +
  DRAFT, untouched original, 2–128 + 409) hold via the create path.
- D2 (import target): `POST :assistantId/versions/import` creates a
  DRAFT child on the EXISTING assistant — never a new assistant. The
  detail UI must unwrap `.export` (pasting raw export files 400s today).
- D3 (codes): all validation failures are 400, never 422 (same family
  as C10 D1 / C11 D3).
- D4 (no-op): same content + no draft → SUCCESS new DRAFT (identical
  hash); same content + existing draft → 409 `draft_exists`. No
  content-dedup anywhere in `createVersion`.
- D5 (contract): client mirrors the tighter-wins contract values via
  the existing `checkDefinitionCaps` (models 16, tools 32, pins 16,
  instructions 20000) — NOT engine maxima. Gaps it doesn't cover
  (temperature/top_p/reasoning/output_schema, toggles, knowledge
  count, guardrail/tool enums, name/description, unknown-keys) are
  enumerated in PLAN but NOT re-implemented: the engine re-validates
  verbatim, and duplicating its zod would be a second derivation that
  drifts. The pane states coverage ("contract pre-check — the engine
  re-validates everything").
- D6 (idempotency): `@Idempotent()` on import, but fresh keys per call
  → no cross-call dedup. Pane disables while pending.
- D7 (landing): nothing highlights today (all three clone entries land
  inconsistently — build vs edit — with no highlight; import stays on
  the modal). Unified: all clones → build path + named toast;
  import → draft-row pulse + scroll + banner on detail.

---

## 9. Dedicated surface plan (keep-vs-extend, gaps, non-goals)

- **Agents list KEEP + EXTEND**: row-menu `Clone` opens the shared
  picker (same component as builder); search/status pills kept; no
  import entry here (host verdict §3).
- **Detail KEEP + EXTEND**: header Clone → shared picker; versions
  actions import modal → full pane (tabs + validator + schema line);
  versions list → highlight prop (pulse + scroll + banner); export
  buttons kept; DiffModal kept.
- **Builder KEEP + EXTEND**: PurposeInspector build button → shared
  picker (fallback kept until wired — then replaced); OriginScreen +
  Clone/Import cards; `origin` state extends (no route change).
- Non-goals: overview surfaces (no clone/import there); description
  editing (no route — C11 D7 stands); rename verb (clone-only,
  PurposeInspector lock note stands); cross-org import (org-scoped
  API); import history/audit views (audit links suffice).

---

## 10. Explicit non-goals + platform asks

- Asks (never faked): per-version `assistantId` reverse lookup (C11 D9
  stands); engine `schema_version` migration (warn-only, R4);
  idempotency-key reuse across calls (D6 — disable-while-pending only).
- Not built: bulk clone/import; import preview-execution (dry-run
  endpoint doesn't exist); conflict merge UI (no-op = success or
  draft_exists — both named); template-ization of imports (C11 owns
  templates).

---

## 11. Query-key + invalidation plan

- Read: AUTHORING (`useAssistants`? — check: assistants list hook key;
  versions, detail) + existing families. No new family.
- Writes: clone/import/create invalidate AUTHORING (hooks do).
  Highlight state is local (session), never cached.
- No shared catalog/health cache touched.

---

## 12. Shortcut impact

None. Pointer-driven overlays; no new keys. Lock test untouched.

---

## Build order (§4 protocol)

1. `builder/lib/origin-model.ts` + test (parse/unwrap/schema/issues/severity/warn-once/draft-exists first).
2. Shared `ClonePicker` + `ImportPane` (agents/ domain dir) + tests.
3. Detail extends: header picker, import modal → pane, versions
   highlight + banner + tests.
4. List extends: row-menu picker + test.
5. Builder extends: PurposeInspector picker, OriginScreen cards,
   `origin` state + tests.
6. Gates once → SPEC flip + README + ledger (§1 row + §7 entry).
