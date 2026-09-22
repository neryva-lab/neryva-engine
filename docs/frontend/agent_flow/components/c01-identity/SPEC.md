# C01. Identity — SPEC (STATUS: SIGNED OFF 2026-09-17)

> Design position: first creation step (Purpose). No dependencies.
> Implementation: `console/neryva-website/src/sections/pages/products/agent-studio/builder/`
> (origin route `/agent-studio/agents/new`, circuit route `/agent-studio/agents/$agentId/build`).

## Engine binds (verified 2026-09-17)

- Create: `POST .../assistants` identity-only (name + description), or `{template}` xor `{definition}` for origin modes (`assistants.controller.ts:19-29`, `assistants.service.ts:90-200`).
- Name: trimmed length **2–128** (`assistants.service.ts:1953`); unique `(organization_id, name)` (`schema.ts:56`); duplicate → typed **409**, never raw 23505 (`assistants.service.ts:357-364`).
- Description: nullable, trimmed, ≤512 (`schema.ts:29`, `assistants.service.ts:90,141`).
- Creating a second draft while one is open → **409** `a draft version already exists for this assistant — publish or delete it before drafting another` (`assistants.service.ts:1929-1945`).
- Discard removes the DRAFT row only; published history untouched (`assistants.service.ts:499-516`).
- Roles: create = owner,admin,developer.

## Design (built in the C01 pass)

- [x] Name field: empty / typing / 409-one-tap-rename states, focus behavior, counter (2–128).
      `inspector/PurposeInspector.tsx` (origin mode) + `inspector/purpose-model.ts`
      (limits + `suggestRename`: "Billing" → "Billing 2" → "Billing 3").
- [x] Description field: optional affordance, counter (≤512). Same files.
- [x] Draft-exists conflict: **deferred with reason, not skipped.** The C01 builder
      introduces zero draft writes (Purpose creates identity; Brain/others are
      read-only until their passes), so the 409 path is unreachable in C01 UI.
      The first draft-writing pass (C04 Brain picker) owns the resume-vs-discard
      dialog, shared with the Engine Room's existing path.
- [x] Permission-denied (viewer): explanatory copy, no silent disable.
      Origin mode renders the denied panel (`setupDeniedCopy(role, 'setup:author')`);
      build mode is read-first-class; the rack degrades to a directory with reasons;
      the empty-card picker gates on `canAuthor`.

## Open questions

- None. Binds complete.
- Recorded (no engine verb exists): identity is write-once. The inspector states
  the no-rename lock with its reason; Clone is the honest rename path and routes
  back into `/build`. A rename endpoint would be engine work + a new pass.

## Exit gate

- Per `../README.md` component gate. Evidence 2026-09-17:
  `purpose-model.test.ts` (limits + rename), `PurposeInspector.test.tsx`
  (counters/validity/viewer/build-read), `projector.test.ts` (origin lock +
  scaffold), `bottom-action.test.ts` (rule 1), `builder-store.test.ts`,
  `SlotNode.test.tsx`, `nav-config.test.ts` (build tails); eslint clean on all
  touched files; `tsc -b` shows only the pre-existing, unrelated
  `ResearchPapers.tsx` motion-typing error (proven present without builder files).
