# C02. Instructions — SPEC (STATUS: SIGNED OFF 2026-09-17)

> Design position: Purpose step, with C01. Depends on: C01 (draft exists before autosave).
> Implementation: `console/neryva-website/src/sections/pages/products/agent-studio/builder/`
> (`inspector/InstructionsSection` + `inspector/SamplesSection` + `lib/instructions-model`,
> PLAN.md). First draft-writing surface in the builder.

## Engine binds (verified 2026-09-17)

- Field `instructions`: optional at type level, max **32,768** (`validation.ts:47`); consumer/contract bound **1–20,000** (`v1.schema.json`); tighter wins → builder enforces **20,000 + non-empty at source**.
- Publish refuses empty instructions: 422 `schema v2 assistants require non-empty instructions to publish` (`validation.ts:182-190`). Never let the user reach the publish phase without them.
- Secrets rejected before persistence: assignment shape (`api_key: sk-…`) and secret-named keys (`validation.ts:128-155`). Prose mentions ("token budget") pass — the control must not flag them.
- Unknown keys anywhere in the payload → 422 dotted paths (`validation.ts:201-211`). The composer must never emit non-contract keys.
- Saved via draft PUT with `If-Match` (412 merge-or-reload); same-hash idempotent.
- Ghost/suggestion text: allowed ONLY from deterministic sources (template starter, reviewed static scaffold library, org history). No backend generation endpoint exists (verified: no suggest/autocomplete route in `engine/src/modules`). Start screen ships with static placeholder until the scaffold library copy is written and reviewed.
- Provenance labels (locked): `Suggested from your organization's agents` vs `Suggested from scaffold library` — always visible, never blended. Org-history source is opt-in (off switch, stated).

## Design (built in the C02 pass — see PLAN.md for the full contract)

- [x] Structured composer (Role / Task / Rules add-row / Examples) + live composed preview (the actual payload text) + raw-text toggle.
      Blocks serialize to canonical Markdown (`## ` markers, Output + Refusal last);
      foreign text degrades to a verbatim Custom block (round-trip property-tested).
      Raw edits set an explicit override with one-tap restore (confirm-guarded).
- [x] Counter (chars vs 20,000; token estimate labeled as estimate).
      Budget bands green/amber/red; Goldilocks note under 500 tokens.
- [x] Secrets whisper (field-level, cites the offending shape, never red-banner).
      Per-block `findSecret` placement; save-blocking (Room parity).
- [x] Empty-instructions whisper at test time ("add instructions for meaningful behavior" — advisory, engine does not require for test).
      Owned by C13 (Response inspector reads emptiness via `isEmptyDocument`, exported for it).
- [x] Draft-exists 409: Room parity (refetch-adopt + guidance toast, no new dialog).
      Satisfies the C01 SPEC deferral; discard stays in Room/Operate.
- [x] 412 merge-or-reload: Room copy skeleton, instructions-only diff.

## Open questions

- Static scaffold library copy: unwritten. Blocks ghost re-introduction, NOT this component.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
