# C03. Brand voice — SPEC (STATUS: SIGNED OFF 2026-09-17)

> Design position: Purpose/Behavior. Depends on: C01. NOTE: older UX docs treated brand as a consumer-side note — that is wrong.
> Implementation: `console/neryva-website/src/sections/pages/products/agent-studio/builder/`
> (sixth satellite slot + `inspector/BrandSection` + `inspector/BrandSamples` +
> `lib/brand-model`, PLAN.md). First-class engine input, first-class surface.

## Engine binds (verified 2026-09-17)

- Field `brand`: **first-class version input**, max **2000** chars (`validation.ts:48-52`).
- Persisted on the version row + policy snapshot, covered by the content hash, composed into the served system prompt at context assembly (pinned snapshot = deterministic, auditable).
- Optional: absent brand = platform default voice. No publish requirement.

## Design (built in the C03 pass — see PLAN.md for the full contract)

- [x] Single textarea with counter (≤2000), "composed into every reply" microcopy.
      Brand satellite node (lilac dock port, `B` shortcut, VOICE palette group,
      `brand→context` leg) + dedicated inspector section. Canvas subtitles:
      `Platform default` when blank (born-ready, never red), `{n} chars` when set.
- [x] Empty state = platform default (stated, not implied).
      Exact copy: `Platform default voice — nothing set. The agent speaks plainly
      until you give it a voice.` Clear-to-empty round-trips (omitted→NULL→`''`).
- [x] Placement decision: Behavior section vs Purpose (record the choice here).
      DECIDED: dedicated brand satellite + inspector (canvas presence + dedicated
      section, no duplication in Purpose). Rationale: voice is first-class runtime
      input (same rank as memory scope); guidelines fail by placement; empty-vs-set
      is meaningful at a glance. Brand is NOT skippable (the default applies
      regardless — a skip would be a lie).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Evidence 2026-09-17:
  `brand-model.test.ts`, `BrandSection.test.tsx` (9: counter, default copy,
  over-limit hold, broadcast whisper, PUT, replace-consent insert, 412 dialog +
  fresh-hash save-over, 409 adopt, viewer), `draft-save.test.ts`,
  projector brand suite (locked/ghost/default-ready/set/leg), store defaults;
  C02's InstructionsSection suite green unmodified after the ConflictDialog +
  debounce extraction (proof of no behavior change); eslint clean on all touched
  files; `tsc -b` shows only the pre-existing, unrelated `ResearchPapers.tsx`
  motion-typing error.
