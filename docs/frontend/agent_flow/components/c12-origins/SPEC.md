# C12. Origins (clone + import) — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: start-screen overlays. Depends on: C01, C02 (prefill targets).

## Engine binds (verified 2026-09-17)

- Clone: full-definition copy as a NEW assistant with DRAFT status; the original is untouched (warn-once line). Same 2–128 name rule + 409 on collision.
- Import: `POST .../versions/import` → DRAFT version (`assistants.service.ts:1156-1217`). Deterministic envelope: `schema_version` validated as number; hash + schema stripped before content comparison. Client validates FIRST (shape + contract caps, exact dotted-path errors) — nothing invalid is sent.
- Import lands on the (new or existing) assistant's draft and must be highlighted, not silently left on the detail page.

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Clone picker (search, status pill, copy semantics warning).
  Shared `ClonePicker` (builder + detail + list, never forked): search over
  names/descriptions, status pills, draft-else-live rule stated per row,
  identity name with one-tap 409 recovery, dismissible untouched-original
  warning, verb-labeled confirm. All three entries land on the build path
  with a named toast.
- [x] Import pane (paste + file drop, client-first validation errors, schema_version display, identity-name resolution).
  Shared `ImportPane` (detail versions + builder origin, never forked):
  Files|Paste tabs, browser-side parse, dotted mono issue list (errors
  block, warnings ride), `schema_version` display (warn, never gate),
  `.export` unwrap, JSON preview, identity resolution (detail: fixed
  target; new-mode: name + create), draft-exists + name-taken recovery,
  draft-row pulse + scroll + banner landing on detail.

## Corrections (found in Step 1 — see PLAN.md §8 D1–D7)

- No `POST .../clone` exists — clone is client composition (behavior
  binds hold via the create path). Import creates a DRAFT child on the
  EXISTING assistant (never a new one); new-mode import composes create.
- All validation failures are 400, never 422. No-op import = success
  new DRAFT (or 409 `draft_exists`); idempotency keys are fresh per call
  (pane disables while pending).
- Provenance carries no version content hash — landing highlight is row
  identity, not hash proof. Uncovered engine caps are enumerated, not
  re-implemented (no second derivation).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
