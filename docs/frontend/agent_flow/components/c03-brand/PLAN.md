# C03. Brand voice — BUILD PLAN (FINAL, 2026-09-17)

> Parent: `SPEC.md` (binds + exit gate; STATUS stays NOT STARTED until this pass
> lands), `ORGANIZATION.md:50,71` (inspector-only, no shared entity — same law as
> C02), `builder/BUILD_PLAN.md`. Pass pattern mirrors C02 deliberately
> (model → section → samples → save pipeline → wiring → gates); deviations are
> §2 and recorded with reasons, never silent.
>
> AMENDMENT (builder-canvas availability): brand ships as the SIXTH satellite
> slot (voice feeds context assembly — first-class runtime input, same rank as
> memory scope). The satellite node is the canvas presence; its inspector is the
> dedicated section. Purpose keeps identity + instructions (no duplication).
> Research backs the visibility: guidelines fail by placement ("live where the
> writing happens"), and empty-vs-set voice is meaningful at a glance.
> Research: brand-voice-as-contract school (adjectives are wishes; trait +
> do/don't + vocabulary rules are contracts); NN/g four tone scales; banned-word
> compliance (~90-95% vs ~50-60% for vague); density over length (<500 words
> guidance); recency (critical rules repeated last); voice-constant/tone-flexes.

## 1. Objective

Ship the Brand voice satellite: a sixth canvas slot (voice feeds context
assembly) with a dedicated inspector section — single textarea (≤2000) with
counter, stated platform-default empty state, "composed into every reply"
microcopy, a voice-chart writing guide (collapsible, static reviewed microcopy —
not a library), brand samples from the same three-source pattern as C02, and the
proven draft save pipeline. No new routes, no new sidebar entries, no backend
changes.

## 2. Non-goals + the one scoping call (read this before reviewing the diff)

- **No block composer.** C02's block machinery pays off for long structured prompts;
  brand is a short single-voice statement (guidance: <500 words; cap 2000 chars).
  The SPEC asks for a single textarea and the field shape agrees — a trait/vocab
  block system would be 60% of C02's cost for duplicated value. The STRUCTURED
  part of brand ships as guidance + samples, not as a second marker format.
  Revisit trigger (written here so it isn't lost): if brand texts in the wild
  grow multi-clause and reviews ask for per-clause diffs, re-propose blocks.
- **No trait sliders / tone scales UI.** NN/g scales and 1-5 ratings are authoring
  aids for humans writing briefs, not model inputs — our field ships text.
  Sliders would imply engine semantics that don't exist (no `tone: {formal: 4}`
  contract anywhere). Refused as theater.
- **No AI voice extraction** ("paste samples, we write your voice") — no backend
  endpoint; same law as C02 suggestions.
- **No org-wide voice database** — ORGANIZATION.md:71, same as instructions.
- **No tone-by-situation matrix UI.** Voice-constant/tone-flexes is documented in
  the writing guide as one line; per-situation overrides have no engine semantic
  (one brand string per version) and would promise flexibility that doesn't exist.

## 3. Data model (`lib/brand-model.ts` — pure, zero imports)

```ts
export const BRAND_LIMIT = 2000;                 // engine z.max + caps brandMax
export function isBrandEmpty(text: string): boolean  // trim-length 0
export function countBrandChars(text: string): number  // text.length (payload bytes)
export function estimateBrandTokens(chars: number): number  // Math.ceil(chars/4), Room parity
```

- No parse/compose (single text field — §2). No IDs, no markers, no custom type.
- Empty (`''`) composes to OMITTED on the wire (existing `toEnginePayload` blank
  rule — verified); NULL on the row reads back as `''` (`fromEnginePayload:362`).
  Empty is therefore a first-class VALID state, not an error: absent = platform
  default voice (SPEC bind, stated in UI, never implied).

## 4. Files (exact — create in this order)

1. `builder/lib/brand-model.ts` + `brand-model.test.ts` — §3 + limit/empty math.
2. `builder/lib/slot-model.ts` (EDIT) — sixth kind `brand` (label Brand, blurb
   `How every reply sounds`, port color lilac `#d8b4fe`, shortcut `B`,
   pass `C03`); default working set gains `sat:brand` (old persisted sets stay
   valid — palette/shortcut summon on demand, no migration); NOT skippable
   (the default voice applies regardless — skip would be a lie).
3. `builder/lib/projector.ts` (EDIT) — brand branch: locked→locked; no
   definition→untouched ghost; definition + blank→`ready` `Platform default`
   (born-ready pattern, guardrails/memory precedent — absence is a valid state,
   never red); definition + text→`ready` `{n} chars`. Leg `brand→context`
   (voice feeds assembly), lit iff a draft exists (defaults flow at runtime,
   guardrails-leg precedent). Column: left (with knowledge/memory).
4. `builder/palette/ComponentPalette.tsx` (EDIT) — VOICE group (Brand card) +
   footer `B brand`; dock-port color from kind meta (automatic).
5. `builder/AgentBuilder.tsx` (EDIT) — `B` summons/focuses brand (same helper);
   `liveKinds` += brand-when-set; `kindDraftEmpty` += brand (blank→true);
   brand dirty OR-ed into the page guard.
6. `builder/inspector/BrandSection.tsx` + `BrandSection.styles.ts` — §5 + §6.
7. `builder/inspector/ConflictDialog.tsx` (NEW, shared) — extract C02's dialog
   generic: props `{assistantId, title, attempted, expectedHash, currentHash,
   pending, diffLabelTheirs, diffLabelMine, onReloadTheirs, onSaveMine, onClose}`.
   C02's `InstructionsSection` switches to it with identical copy (no behavior
   change; its tests still green = extraction proof). Brand passes brand text.
   Rationale recorded: copy parity across surfaces beats two forked dialogs.
8. `builder/lib/draft-save.ts` (NEW, shared) — `AUTOSAVE_MS` (8000, unified) +
   `buildDraftPayload(definition, patch)` helper. C02 refactored to it in-pass
   (its save tests still green = proof). Single debounce constant — the rule.
9. `builder/inspector/BuilderInspector.tsx` (EDIT) — brand satellite selection
   renders `<BrandSection/>` (dedicated section); Purpose keeps identity +
   instructions (no duplication).
10. No bottom-action change (brand is optional; no rule owns it). No projector
    status beyond §4.3 (no gate rides on brand).

## 5. Form structure (every field, every behavior)

- Textarea, rows 4, label `Brand voice`, placeholder with an enforceable example
  (`Short sentences. Contractions always. Never say “leverage”.` — teaches the
  trait+rule shape, not adjectives).
- Microcopy under the label (exact): `Composed into every reply, ahead of instructions.`
  (composition truth, G4 — placement in the prompt is a fact makers deserve).
- Empty state (exact, when blank AND clean): `Platform default voice — nothing set.
  The agent speaks plainly until you give it a voice.` (stated default, SPEC bind).
- Counter: `{chars} / 2,000` + `~{tokens} tokens (est.)` + budget bar (same bands
  component pattern as C02 — extract shared `CounterBar`? NO: duplicate 20 lines.
  Two usages don't justify an abstraction; three will. Recorded.)
- Voice-chart guide (collapsible `<details>`-style, static reviewed microcopy —
  5 lines, written once in the pass, never fetched):
  `Name 2–3 traits as rules, not adjectives (“short sentences” beats “friendly”).
   List words to use and words to never use. Show one do and one don't.`
  Plus the don't-column principle in one line:
  `The don'ts do the most work — generic models drift exactly where you don't forbid.`
- Secrets whisper: same `findSecret`-shell pattern as C02 over the brand text
  (STRONGER case here: brand ships into EVERY reply, so a pasted secret is a
  broadcast — whisper copy names that: `This looks like a pasted credential —
  brand ships into every reply. Mention it, don't paste it.`). Save-blocking,
  Room parity.
- Over-limit: held whisper (caps message verbatim) + autosave held, same as C02.
- Viewer: read-only text + counter; samples browsable, insert denied (pattern).
- Keyboard/a11y: native textarea (free semantics); Esc-blur parity with C02
  (same root-handler one-liner — canvas deselect already stands down while dirty).

## 6. Save pipeline (proven C02 mechanics, brand payload)

- Source: `definition.brand` (blank `''` when NULL — never null in UI state).
- Autosave 8000ms (unified constant — import from a shared `builder/lib/save.ts`?
  NO: C02 hardcodes with comment; C03 imports a shared `AUTOSAVE_MS` from
  `lib/instructions-model.ts`?? Wrong home. Decision: new `builder/lib/draft-save.ts`
  exporting `AUTOSAVE_MS` + `buildDraftPayload(definition, patch)` helper
  (`{...definition, ...patch}` typed)? Minimal shared surface, both sections import.
  C02 refactored to it in-pass (its save tests still green = proof).
  Hmm — scope check: this touches C02's file. Justified (single debounce constant
  was an explicit TODO-class rule: "two debounce constants is config slop").
- Write path: PUT (draft+hash) / POST (otherwise), full payload with brand swapped
  in, `If-Match`, 409 adopt-with-guidance, 412 shared ConflictDialog (brand diff),
  dirty flag up. Identical state machine to C02 §6, brand text substituted.
- Empty saves: omitted-on-wire → NULL → reads back `''` → dirty resolves. The
  "clear my voice" path works end to end (test it: seed → clear → save → echo).
- Dirty: `brand !== sourceBrand` → page guard extension (one line + test).

## 7. Samples (same three-source pattern, brand excerpts)

- Rendered INSIDE BrandSection under a `Use a voice sample` toggle (collapsed by
  default unless blank — same onboarding rule as C02).
- Template starters: `definition.brand` raw-read (defensive: string-or-absent;
  VERIFY-ITEM in pass — if no registry template carries brand yet, the group shows
  ONE honest row `No voice samples in the registry yet` disabled, never synthesized).
  Card: humanized slug + char count + `From template starters` chip.
- Org agents: same opt-in switch (SHARED preference key with C02 —
  `neryva.builder.orgSamples.<orgId>` — one toggle, both galleries; switching it in
  either place reflects in both. Documented, tested), same cap-6, same failure note.
  Card: agent name + 140-char excerpt + chip. Rows reuse a shared `OrgVoiceRow`?
  C02's row is instructions-shaped (rule/custom mapping). Brand rows map to plain
  text insert — implement `OrgBrandRow` beside it (20 lines duplicated over a wrong
  abstraction; recorded).
- Scaffold row: disabled `pending review` (same).
- Insert: REPLACE-with-explicit-choice (differs from C02 append — and deliberately:
  a voice is singular; appending two voices breeds contradiction. The insert button
  reads `Use this voice`, opens the section's ConfirmDialog
  (`Replace the current voice? Versions keep the old one.`), then sets text.
  Non-destructive by construction (versions are undo) + explicit consent. Viewer: denied.
- Provenance chips identical to C02 (locked copy).

## 8. Copy deck (exact strings)

- Microcopy: `Composed into every reply, ahead of instructions.`
- Empty: `Platform default voice — nothing set. The agent speaks plainly until you give it a voice.`
- Placeholder: `Short sentences. Contractions always. Never say “leverage”.`
- Guide (4 lines + don'ts line, §5 verbatim).
- Secrets: `This looks like a pasted credential — brand ships into every reply. Mention it, don't paste it.`
- Over-limit: caps message verbatim + ` Autosave held — fix it and saving resumes on its own.` (C02 pattern).
- Insert confirm: `Replace the current voice?` / `Versions keep the old one — nothing is lost.`
- Insert toast: `Voice set — every save is a version.`
- 409/412: identical copy to C02 flows (shared dialog).

## 9. Tests (gate)

- `brand-model.test.ts`: limit const, empty/whitespace, char/token math.
- `BrandSection.test.tsx` (mocked hooks, same harness as C02): renders text+counter;
  over-limit holds save (no mutate); secrets whisper + hold; empty→default copy;
  viewer read-only; template insert with replace-confirm; org opt-in row insert;
  clear-to-empty saves and echoes (POST omits → NULL → `''`); 412 dialog renders
  with brand diff and save-mine calls with fresh hash; 409 adopt toast.
- Shared-dialog extraction: C02's InstructionsSection suite stays green unmodified
  (proof of no behavior change) + one render test for the generic dialog copy.
- `draft-save.ts`: constant value test (8000) — trivial but pins the unification.
- Manual QA (subset of C02's list, brand deltas): clear-voice round trip; viewer;
  template-without-brand card; 20-char-over paste; two-tab 409 on brand edit.

## 10. Build order

1. VERIFY-ITEM (registry brand presence — decides one gallery row; 10 minutes, blocks nothing else).
2. Slot foundation: slot-model 6th kind + defaults, projector branch + leg, palette VOICE group + footer, keyboard `B`, AgentBuilder deltas (liveKinds/draftEmpty) — with tests. Canvas presence first, so every later step is visible.
3. `brand-model` + tests.
4. `draft-save.ts` + C02 refactor to it (C02 suite green = proof).
5. `ConflictDialog` extraction (C02 suite green = proof).
6. `BrandSection` + styles (composer, counter, guide, whisper, viewer).
7. Brand samples (template group, org rows, scaffold row, replace-confirm insert).
8. Save wiring (PUT/POST/409/412/dirty) + component tests.
9. Inspector (satellite→section) + page wiring.
10. Full gates + SPEC flip to SIGNED OFF.

## 11. Exit mapping (SPEC design boxes → this plan)

- Single textarea + counter → §5.
- "Composed into every reply" microcopy → §5 (composition fact).
- Empty = platform default, stated → §5 (exact copy in §8).
- Placement decision → §4: dedicated brand satellite + inspector (canvas presence
  + dedicated section, no duplication in Purpose; recorded here, goes into SPEC
  on flip).

## 12. Open items (1)

1. Registry brand presence (VERIFY-ITEM §7 — one honest row either way).
