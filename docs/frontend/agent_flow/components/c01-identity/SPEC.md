# C01. Identity — SPEC (STATUS: NOT STARTED)

> Design position: first creation step (Purpose). No dependencies.

## Engine binds (verified 2026-09-17)

- Create: `POST .../assistants` identity-only (name + description), or `{template}` xor `{definition}` for origin modes (`assistants.controller.ts:19-29`, `assistants.service.ts:90-200`).
- Name: trimmed length **2–128** (`assistants.service.ts:1953`); unique `(organization_id, name)` (`schema.ts:56`); duplicate → typed **409**, never raw 23505 (`assistants.service.ts:357-364`).
- Description: nullable, trimmed, ≤512 (`schema.ts:29`, `assistants.service.ts:90,141`).
- Creating a second draft while one is open → **409** `a draft version already exists for this assistant — publish or delete it before drafting another` (`assistants.service.ts:1929-1945`).
- Discard removes the DRAFT row only; published history untouched (`assistants.service.ts:499-516`).
- Roles: create = owner,admin,developer.

## Design (fill in the C01 pass)

- [ ] Name field: empty / typing / 409-one-tap-rename states, focus behavior, counter (2–128).
- [ ] Description field: optional affordance, counter (≤512).
- [ ] Draft-exists conflict: resume vs discard-confirm copy.
- [ ] Permission-denied (viewer): explanatory copy, no silent disable.

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
