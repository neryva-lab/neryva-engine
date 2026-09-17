# C12. Origins (clone + import) — SPEC (STATUS: NOT STARTED)

> Design position: start-screen overlays. Depends on: C01, C02 (prefill targets).

## Engine binds (verified 2026-09-17)

- Clone: full-definition copy as a NEW assistant with DRAFT status; the original is untouched (warn-once line). Same 2–128 name rule + 409 on collision.
- Import: `POST .../versions/import` → DRAFT version (`assistants.service.ts:1156-1217`). Deterministic envelope: `schema_version` validated as number; hash + schema stripped before content comparison. Client validates FIRST (shape + contract caps, exact dotted-path errors) — nothing invalid is sent.
- Import lands on the (new or existing) assistant's draft and must be highlighted, not silently left on the detail page.

## Design (fill in the C12 pass)

- [ ] Clone picker (search, status pill, copy semantics warning).
- [ ] Import pane (paste + file drop, client-first validation errors, schema_version display, identity-name resolution).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
