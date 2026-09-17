# C03. Brand voice — SPEC (STATUS: NOT STARTED)

> Design position: Purpose/Behavior. Depends on: C01. NOTE: older UX docs treated brand as a consumer-side note — that is wrong.

## Engine binds (verified 2026-09-17)

- Field `brand`: **first-class version input**, max **2000** chars (`validation.ts:48-52`).
- Persisted on the version row + policy snapshot, covered by the content hash, composed into the served system prompt at context assembly (pinned snapshot = deterministic, auditable).
- Optional: absent brand = platform default voice. No publish requirement.

## Design (fill in the C03 pass)

- [ ] Single textarea with counter (≤2000), "composed into every reply" microcopy.
- [ ] Empty state = platform default (stated, not implied).
- [ ] Placement decision: Behavior section vs Purpose (record the choice here).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
