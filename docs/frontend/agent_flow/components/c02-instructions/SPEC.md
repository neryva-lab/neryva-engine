# C02. Instructions — SPEC (STATUS: NOT STARTED)

> Design position: Purpose step, with C01. Depends on: C01 (draft exists before autosave).

## Engine binds (verified 2026-09-17)

- Field `instructions`: optional at type level, max **32,768** (`validation.ts:47`); consumer/contract bound **1–20,000** (`v1.schema.json`); tighter wins → builder enforces **20,000 + non-empty at source**.
- Publish refuses empty instructions: 422 `schema v2 assistants require non-empty instructions to publish` (`validation.ts:182-190`). Never let the user reach Ship without them.
- Secrets rejected before persistence: assignment shape (`api_key: sk-…`) and secret-named keys (`validation.ts:128-155`). Prose mentions ("token budget") pass — the control must not flag them.
- Unknown keys anywhere in the payload → 422 dotted paths (`validation.ts:201-211`). The composer must never emit non-contract keys.
- Saved via draft PUT with `If-Match` (412 merge-or-reload); same-hash idempotent.
- Ghost/suggestion text: allowed ONLY from deterministic sources (blueprint starter, reviewed static scaffold library, org history). No backend generation endpoint exists (verified: no suggest/autocomplete route in `engine/src/modules`). Start screen ships with static placeholder until the scaffold library copy is written and reviewed.

## Design (fill in the C02 pass)

- [ ] Structured composer (Role / Task / Rules add-row / Examples) + live composed preview (the actual payload text) + raw-text toggle.
- [ ] Counter (chars vs 20,000; token estimate labeled as estimate).
- [ ] Secrets whisper (field-level, cites the offending shape, never red-banner).
- [ ] Empty-instructions whisper at Try ("add instructions for meaningful behavior" — advisory, engine does not require for test).

## Open questions

- Static scaffold library copy: unwritten. Blocks ghost re-introduction, NOT this component.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
