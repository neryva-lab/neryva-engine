# C02. Instructions — BUILD PLAN (FINAL, 2026-09-17)

> Parent: `SPEC.md` (binds + exit gate), `ORGANIZATION.md:50,71` (inspector-only,
> no shared entity, never a new backend), `builder/BUILD_PLAN.md` (circuit contract).
> Research: Anthropic XML/Markdown guidance; Langfuse versions+labels model;
> Mastra prompt-blocks (versioned drafts + preview); block-builder UX
> (structured fields + live Markdown preview); primacy/recency placement.

## 1. Objective

Ship the Instructions section in the Purpose inspector: a structured composer
(Role / Task / Rules / Examples / Output / Refusal) that composes deterministic
Markdown into the version `instructions` field, with samples from the three locked
sources, counters, secrets whisper, and the same save pipeline as the Room.
No new routes, no new sidebar entries, no backend changes.

## 2. Non-goals (refused here, with reason)

- Org-wide instructions database / standalone "new instruction" object — forbidden
  by ORGANIZATION.md:71; instructions don't exist without an agent.
- AI-generated suggestions — no backend endpoint exists (SPEC binds); theater.
- Scaffold-library copywriting — separate review (SPEC open question); the gallery
  row ships disabled-but-visible, never with placeholder text.
- JSON-as-authoring-format — review-hostile, escaping pain, token overhead.
  JSON is for machine *output*, not human authoring (research consensus).
- XML markers — Claude-favoring; Markdown headers are model-neutral, human-diffable.
- Drag-reorder of rules — Chevron up/down buttons (same outcome, no dnd dependency,
  keyboard-free Accessible by default). Revisit only with a real a11y-tested need.
- Variables (`{{x}}`) — engine has no compile step; a `{{var}}` would ship literally
  to the model. Refused until a render contract exists.

## 3. Data model

### 3.1 Block types (`lib/instructions-model.ts`)

```ts
export type InstructionBlockType = 'role' | 'task' | 'rule' | 'example' | 'output' | 'refusal' | 'custom';
export interface InstructionBlock { id: string; type: InstructionBlockType; body: string; }
export interface ComposedDocument { blocks: InstructionBlock[]; overridden: boolean; rawOverride: string; }
```

- Singletons: `role`, `task`, `output`, `refusal` (max one each; UI offers "edit",
  never "add another" — a second Output block is a contradiction, refused at data level).
- Lists: `rule` (one-line inputs), `example` (title + body textarea, free text —
  pairs over-engineer the 80% case; research: 2–3 canonical examples).
- `custom`: verbatim foreign text (see §3.3). Editable, deletable, never auto-split.
- `id`: `block:<counter>` from a module counter (local keys only, never persisted,
  never sent — the engine sees text).

### 3.2 Canonical order (primacy/recency — research-mandated, not aesthetic)

`role → task → rules[] → examples[] → output → refusal → custom?`

- Identity first (models attend early). Output contract before refusal.
- Refusal/escalation LAST (recency: the most critical line survives long contexts).
- `custom` pins last when present (unknown content never interleaves and reorders
  authored clauses — a foreign paste cannot reshuffle your safety block).

### 3.3 Marker format (exact — the only serialization)

```md
## Role
<role body>

## Task
<task body>

## Rules
- <rule 1>
- <rule 2>

## Examples
### Example 1
<example body>

## Output
<output body>

## Refusal
<refusal body>
```

- Sections join with exactly `\n\n`; rules with `\n`; file ends with exactly one `\n`.
- Headers match case-insensitively, tolerating trailing `:` and `#` variants on READ
  (`## rules:`, `## RULES` all parse); WRITE always emits the canonical form above.
- `### Example <n>` numbering is cosmetic — parse accepts any `### ` line inside
  Examples as a separator; numbering is re-emitted sequentially on compose.
- Empty sections are OMITTED on compose (no `## Task` with nothing under it —
  blank headers are noise tokens billed on every run).

### 3.4 Parse rules (lossless by construction)

1. Scan lines; a known marker (`## role|task|rules|examples|output|refusal`) opens
   that section. Rule bullets: lines starting with `- ` (also `* `, `• `, `N. ` —
   normalized to `- ` on compose; content preserved verbatim otherwise).
2. ALL other content — preamble before the first marker, unknown `## ` headers,
   trailing prose — is collected IN ORDER into ONE `custom` block, stored VERBATIM
   (no trimming beyond stripping the single newline that separates it from markers).
3. Composer-produced text round-trips byte-identical (property test, §9).
4. Foreign text normalizes ONCE on first open (markers canonicalized, bullets
   normalized) — the inspector toasts `Formatted into blocks — content preserved.`
   exactly once per source text (hash-keyed dismissal, session-only). No silent rewrites.
5. `body` of typed blocks: inner text verbatim (leading/trailing blank lines trimmed
   at most one — code examples keep their indentation; never reindent).

### 3.5 Versioning mapping (Langfuse analog, no new backend)

Our versions table already IS versions+labels: immutable versions = versions,
`active_version_id` = `production`, open draft = `latest`/staging, rollback exists
(P6 lineage). The composer therefore needs NO version UI — every save appends a
version (C01 undo insight), history/restore live in Operate. The plan forbids a
parallel "prompt versions" concept anywhere in C02 code or copy.

## 4. Files (exact — create in this order)

1. `builder/lib/instructions-model.ts` — types, `parseInstructions(text)`,
   `composeInstructions(blocks)`, `blankDocument()`, `isEmptyDocument(doc)`,
   `countChars(doc)`, `estimateTokens(chars) = Math.ceil(chars/4)` (Room parity),
   `LIMIT = 20000`, block factories. Zero imports (pure).
2. `builder/lib/instructions-model.test.ts` — §9 tables.
3. `builder/inspector/InstructionsSection.tsx` + `.styles.ts` — composer (§5).
4. `builder/inspector/SamplesSection.tsx` + `.styles.ts` — three-source gallery (§7).
5. `builder/inspector/BuilderInspector.tsx` (EDIT) — Purpose selection renders
   identity summary + `<InstructionsSection/>`; Brain/other placeholders untouched.
6. `builder/lib/projector.ts` (EDIT) — Purpose derivation: draft + empty
   instructions → `attention`, subtitle `Missing — publish refuses`; draft +
   non-empty → `ready`, subtitle `${chars} chars · ${rules} rules`.
7. `builder/lib/bottom-action.ts` (EDIT) — new rule after 4 (`instructionsEmpty`
   input): primary `Write instructions` → select `purpose`; whisper
   `Publish refuses empty instructions — the composer is one click away.`
   + tests.
8. `builder/AgentBuilder.tsx` (EDIT) — pass `instructionsEmpty` into derivation;
   nothing else (save pipeline lives in the section, §6).

## 5. Form structure (every field, every behavior)

### 5.1 Composer layout (Compose tab — default)

- `role`: TextArea, rows 3, label `Role — who this agent is`, per-block counter.
- `task`: TextArea, rows 2, label `Task — the job in one breath`.
- `rules[]`: single-line TextInputs, `Enter` commits + appends a fresh row focused;
  `×` deletes (no confirm — keystrokes are cheap, versions are the undo);
  `↑`/`↓` chevron buttons reorder (disabled at ends, with `aria-label`s).
- `examples[]`: title Input (placeholder `Edge case: angry refund request`) +
  body TextArea rows 3. `+ Add example` (cap 6 — research: 2–3 canonical beats 10
  mediocre; the cap states its reason inline).
- `output`: TextArea rows 2, label `Output — the response contract`, placeholder
  with an enforceable example (`Verdict + section cite · max 3 exchanges`).
- `refusal`: TextArea rows 2, label `Refusal — the exact fallback`, placeholder
  (`Over $500 or off-policy → escalate to a human`).
- `custom` (if present): full-width TextArea rows 6, amber left border, label
  `Custom text — preserved verbatim`, sub `Delete only; the composer never edits this.`
  (delete allowed; edit allowed; split refused — §2).
- `+ Add` row: `+ Rule`, `+ Example` text buttons (singletons never offered).
- Empty document (fresh draft, no text): composer shows Role/Task empty + rules
  empty-state `No rules yet — one rule per line works best.` + Samples CTA
  (the fastest path from blank is a sample, not a lecture).

### 5.2 Tabs: Compose | Preview | Raw (segmented, Apple lineage)

- Preview: read-only mono rendering of `composeInstructions(blocks)` — "what the
  model receives", with per-section anchors (clicking a section selects its block).
- Raw: textarea of the composed text. Editing raw sets `overridden=true` +
  banner `Custom text — composer paused · Restore from blocks` (one tap restores;
  restore DISCARDS raw edits after an inline confirm — the only confirm in C02,
  because it destroys work). Leaving Raw keeps the override; structured edits are
  disabled while overridden (visibly, with reason — never silently).
- Tab state is UI-local (not persisted); reload lands on Compose.

### 5.3 Counters + budget bands

- Total: `{chars} / 20,000` + `~{tokens} tokens (est.)` + progress bar:
  green < 70%, amber 70–100%, red over (bar only — no banner).
- Per-block micro-counters (right-aligned, ghost text).
- Over-limit: autosave HELD (same pattern as Room issues), whisper
  `{n} over the 20,000 cap — trim to save.` Save resumes automatically when valid.
- Goldilocks note (one line, muted, shown under 500 tokens):
  `Short prompts hold shape better — cut a paragraph, re-run evals, keep what scores.`

### 5.4 Secrets whisper

- Runs `findSecret` (existing, `setup-caps.ts`) over composed text on every change
  (cheap, synchronous). Hit → amber field-level note ON THE OFFENDING BLOCK:
  `Looks like {shape} — secrets are refused at save. Mention it, don't paste it.`
- Secrets are save-BLOCKING (Room parity — engine rejects before persistence):
  the note names the block; autosave holds with reason; no red banner anywhere.

### 5.5 Viewer mode

- Blocks render read-only (same layout, no inputs, no add/delete, no tabs-editing —
  Preview tab only + counter). Samples gallery visible; insert buttons replaced by
  denied note (`setupDeniedCopy`, established pattern). No silent hiding.

### 5.6 Keyboard / a11y

- All controls native inputs (free Tab order, free screen-reader semantics).
- Rule-row `Enter` = commit + new row; `Esc` in composer = blur (never deselect —
  canvas owns Esc).
- Status changes announced via the existing save-state live region (no new live regions).

## 6. Save pipeline (first draft-writer — owns the 409 dialog)

- Source: `useAssistantDefinition` (draft ?? active ?? blank) + local block state,
  initialized on first data (guard: init once per versionId+hash — stale-init
  overwrites are the classic composer bug; the guard key is `${versionId}:${hash}`).
- Autosave: 8000ms debounce after last keystroke (verified Room `AUTOSAVE_MS` —
  unified constant, not a second value; every save mints an immutable version,
  so a tight debounce would spam history).
- Write path: `isDraft && versionId` → `useUpdateDraftVersion` PUT + `If-Match`;
  else → `useSaveDraftVersion` POST (full payload: current definition with
  composed instructions swapped in — NEVER a partial body; unknown-keys 422).
- Held saves (over-limit / secrets / caps): no request fires; the whisper IS the UI.
  Empty instructions are HELD by `checkDefinitionCaps` (Room parity — the engine
  would permit empty at save since PUT replaces with NULL, but both surfaces
  require text; publish refuses regardless). Never conflate save-gates with
  publish-gates in copy.
- 409 `draft already exists` (POST race) → Room parity, no new dialog:
  invalidate authoring (refetch adopts the draft as the save target), toast
  `A draft opened elsewhere — resumed it. Your text stays; the next save writes
  to it.` Discard stays where it lives (Engine Room / Operate) — the builder
  never destroys versions. (C01 SPEC deferral satisfied by parity, not dialog.)
- 412 → conflict dialog mirroring the Room's MergeModal copy skeleton
  (`Someone saved first — merge or reload`, both hashes, `Reload theirs` /
  `Save mine over theirs` / `Keep editing (autosave stays off)`), diffing only
  the instructions text (theirs vs mine, truncated) instead of the full
  definition diff. Composer freezes while open.
- Dirty guard: composer edits set the page-level dirty flag (same `useDirtyGuard`;
  extend the page's dirty condition — one-line AgentBuilder edit, listed in §4.8).
- Save-state readout: topbar `Saved/Syncing` already binds query state — no new UI.

## 7. Samples (three sources, locked provenance)

1. **Template starters** (engine registry — real today). VERIFY-ITEM in pass:
   confirm the template read carries definition/instructions text
   (`useAssistantTemplate`); if a template lacks instructions, its card shows
   `No starter text` disabled — never synthesize. Card: name + block count
   (parsed, honest) + `From template starters` chip.
2. **Org agents** (opt-in, OFF by default; toggle persisted
   `neryva.builder.<orgId>.orgSamples`, window-guarded like all UI state).
   ON → fetch definitions for up to 6 most-recently-updated OTHER assistants
   (`useAssistantDefinition` each — cached, lazy on toggle, skeleton rows, one
   shared error note on partial failure listing count, never per-row toasts).
   Card: agent name + excerpt (first 140 chars) + `From your org's agents` chip.
   Provenance is shown at pick time + insert toast; persistence of provenance is
   impossible (engine text carries no meta) — documented, not promised.
3. **Scaffold library**: disabled row `Reviewed starter set — pending review`
   (SPEC open question; zero placeholder text ever).
- Insert = **append-as-block(s)** onto the live document (template starter parsed
  to blocks; org excerpt appended as ONE new rule? NO — as one new `example`?
  Neither: appended as a `custom` block titled by source? Decision: template
  starters merge blockwise (role fills empty role only — never overwrites a
  non-empty singleton; lists append); org excerpts append as ONE `rule` ONLY if
  single-line, else ONE `custom` block (verbatim, source-named). No destructive
  insert path exists. Toast confirms with undo-via-versions hint
  (`Inserted below your blocks — every save is a version.`).

## 8. Copy deck (exact strings — no improvisation in pass)

- Empty composer: `No rules yet — one rule per line works best.`
- Samples CTA (empty): `Fastest start: use a sample — appends as blocks, nothing overwritten.`
- Over-limit: `{n} over the 20,000 cap — trim to save.`
- Secrets: `Looks like {shape} — secrets are refused at save. Mention it, don't paste it.`
- Raw override: `Custom text — composer paused` / `Restore from blocks` (+ confirm
  `Discard raw edits and restore from blocks?`).
- 409 dialog: title/body/buttons per §6.
- First-parse normalize: `Formatted into blocks — content preserved.`
- Insert: `Inserted below your blocks — every save is a version.`
- Purpose attention (projector): `Missing — publish refuses.`
- Bottom rule: `Write instructions` / `Publish refuses empty instructions — the composer is one click away.`
- Goldilocks: `Short prompts hold shape better — cut a paragraph, re-run evals, keep what scores.`

## 9. Tests (gate — no pass without all green)

- `instructions-model.test.ts`: marker table (canonical + `## RULES:`/`## Rules` variants
  + `*`/`•`/`1.` bullets + `### Anything` separators); byte-identical round-trip
  property (compose→parse→compose on 12 fixtures incl. code fences with `#` lines,
  `## ` inside example bodies, CRLF input, 20k-char input, empty string);
  foreign-text → single custom verbatim (byte-exact); unknown headers preserved;
  empty sections omitted; `### Example` renumbering; LIMIT/estimate math.
- Component (`InstructionsSection.test.tsx`, mocked hooks): renders blocks from
  definition; add-rule Enter flow; singleton non-duplication (Output offered once);
  over-limit holds save (assert no mutate); secrets whisper appears on `sk-…`;
  viewer renders read-only; raw override banner + restore confirm; 409 dialog copy
  (mock mutation error → dialog, both buttons call the right mutations).
- Projector/bottom-action deltas: purpose attention/subtitle table; new bottom rule
  order test (sits after rule 4, before Engine-Room fallback).
- Manual QA list: Room↔builder same-text parity (identical payload bytes for identical
  intent); reload mid-edit (init guard); two-tab 409; viewer role; 20,001-char paste;
  template without instructions; org-toggle with 0/1/7+ agents; CRLF paste from Windows.

## 10. Build order (in-pass sequence)

1. `instructions-model.ts` + tests (nothing else starts until round-trip is green).
2. Samples VERIFY-ITEM (template read shape) — decides card rendering, blocks nothing else.
3. Projector + bottom-action deltas + tests.
4. `InstructionsSection` composer (blocks, tabs, counters, whisper, viewer).
5. Save pipeline (debounce, POST/PUT, 409 dialog, 412 panel, dirty flag).
6. `SamplesSection` (gallery, opt-in, capped reads, insert paths).
7. Inspector wiring + AgentBuilder dirty extension.
8. Full gates (vitest / eslint / tsc / vite build) + SPEC flip to SIGNED OFF.

## 11. Exit mapping (SPEC design boxes → this plan)

- Structured composer + preview + raw toggle → §5.1/§5.2.
- Counter + estimate → §5.3 (formula fixed, Room parity).
- Secrets whisper → §5.4 (existing detector, Room-parity blocking).
- Test-time empty whisper → owned by C13 (Response inspector reads emptiness;
  recorded here so it isn't lost — C02 exposes `isEmptyDocument` for it).
- Ghost re-introduction → still blocked on scaffold copy (unchanged); samples use
  only deterministic sources (§7).

## 12. Open items (1 — verify-item, blocks nothing)

1. Template read shape for starter text (VERIFY-ITEM §7.1 — decides one card state).
   (Resolved during planning: `definition.instructions` string-or-absent,
   InstallWizard already reads it. Room debounce also resolved: 8000ms unified.)
