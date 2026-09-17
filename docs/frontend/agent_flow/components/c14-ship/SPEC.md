# C14. Ship — SPEC (STATUS: NOT STARTED)

> Design position: readiness → publish → success. Depends on: ALL of C01–C13.

## Engine binds (verified 2026-09-17)

- Required set (render from the required-checks read, NEVER hardcoded): instructions present; ≥1 usable model; knowledge pins resolved or degraded-acknowledged; tool pins valid (fresh schema_hash); tool approvals satisfied; eval required-checks passed (fresh PASS on content hash where declared); no blocking control blocks; no schema drift.
- Gate refusals are **409** verbatim (BLOCK message / required-checks message + required list + latest decision: `release-gate.ts:32-62`). Publish click with open issues scrolls to the first — never a dead click.
- Degraded publish: `acknowledge_degraded_knowledge: true` in the publish body (also accepted on rollback), audited as `assistant.publish_degraded_acknowledged` (`assistants.controller.ts:181-187,245`).
- Publish is idempotent, advisory-locked, atomic pointer swing; snapshot/provenance materialized in the TX; in-flight runs stay pinned. 412 on stale draft → merge-or-reload, draft intact. Failure reverses any ceremony, whisper states the exact issue.
- No-op publish is a joint content+manifest 409 (`assistant active version already carries this payload`). Pre-empt with a `No changes to publish` state (muted, explanatory — never a surprise 409). Exceptions that keep the button live: prompt/params-only edits always publish (manifest excludes prompt); same content + drifted manifest = legitimate re-publish that re-pins the world (`assistants.service.ts:1844-1889`).
- Success: version number + hash + template badge + eval decision on that hash + degraded statement. Next: connect channel (with `returnTo`), watch (operate), build another, back to fleet.

## Design (fill in the C14 pass)

- [ ] Readiness card (required vs optional-skipped sections, per-row inline fix or one-tap jump, anchored popover).
- [ ] Publish rail (content hash, schema version, snapshot note, rollout-at-publish note, what-happens list).
- [ ] Degraded-acknowledge copy (explicit consequence + audit note).
- [ ] Success screen (3 exits + provenance footer).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
