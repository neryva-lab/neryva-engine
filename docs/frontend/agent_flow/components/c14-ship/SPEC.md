# C14. Publish — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: readiness → publish → success. Depends on: ALL of C01–C13.
> Roles (verified): publish/rollback = owner,admin ONLY (`assistants.controller.ts:173-175`).
> Developers get an explained Publish row (why + request path), never a silent disable. Test/evaluate stay developer-open.

## Engine binds (verified 2026-09-17)

- Required set (render from the required-checks read, NEVER hardcoded): instructions present; ≥1 usable model; knowledge pins resolved or degraded-acknowledged; tool pins valid (fresh schema_hash); tool approvals satisfied; eval required-checks passed (fresh PASS on content hash where declared); no blocking control blocks; no schema drift.
- Gate refusals are **409** verbatim (BLOCK message / required-checks message + required list + latest decision: `release-gate.ts:32-62`). Publish click with open issues scrolls to the first — never a dead click.
- Degraded publish: `acknowledge_degraded_knowledge: true` in the publish body (also accepted on rollback), audited as `assistant.publish_degraded_acknowledged` (`assistants.controller.ts:181-187,245`).
- Publish is idempotent, advisory-locked, atomic pointer swing; snapshot/provenance materialized in the TX; in-flight runs stay pinned. 412 on stale draft → merge-or-reload, draft intact. Failure reverses any ceremony, whisper states the exact issue.
- No-op publish is a joint content+manifest 409 (`assistant active version already carries this payload`). Pre-empt with a `No changes to publish` state (muted, explanatory — never a surprise 409). Exceptions that keep the button live: prompt/params-only edits always publish (manifest excludes prompt); same content + drifted manifest = legitimate re-publish that re-pins the world (`assistants.service.ts:1844-1889`).
- Success: version number + hash + template badge + eval decision on that hash + degraded statement. Next: connect channel (with `returnTo`), watch (operate), build another, back to agents.
- Zero-agent Channels entry: channels require an existing agent — the success screen's channel exit must inline-create-or-pick with `returnTo`, never land on a dead "Binding required" (carry into acceptance).

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Readiness card (required vs optional-skipped sections, per-row inline fix or one-tap jump, anchored popover).
  Verdict-first card (Go / Conditional-Go-with-named-exception / No-Go,
  never a percentage) over six REQUIRED rows in server order, each with its
  fix route or slot jump; publish click with open issues scrolls to the
  first (aria-disabled, never a dead click). No advisory rows — phantom
  gates (approvals, control-blocks, drift-as-refusal) are not engine gates
  and render nowhere. Shared `ReadinessRows` + `usePublishReadiness` /
  `derivePublishReadiness` (single derivation, both surfaces).
- [x] Publish rail (content hash, schema version, snapshot note, rollout-at-publish note, what-happens list).
  Rail receipt before the click: content hash, schema v2, in-TX snapshot +
  pointer swing note, in-flight-runs-pinned note, audit link. Provenance is
  a derived read (not in-TX — corrected). No rollout note (C15 owns
  rollouts; publish ships the pointer only).
- [x] Degraded-acknowledge copy (explicit consequence + audit note).
  Explicit hallucination consequence + `assistant.publish_degraded_acknowledged`
  audit note + 7-day waiver lifecycle line; ack arms Conditional-Go, never
  a silent warn-toast. Rollback accepts the same ack.
- [x] Success screen (3 exits + provenance footer).
  Shared `PublishSuccess`: composed receipt (version + hash from the POST;
  badge/decision/statement from reads — the POST returns `{ version }`
  only) + Connect-channel (with new `returnTo` plumbing, returns after
  connect) / Watch-in-operate / Back-to-agents + Test-live link +
  provenance footer with audit link.

## Corrections (found in Step 1 — see PLAN.md §8 D1–D10)

- No required-checks endpoint (composed read); no 412 on publish/rollback
  (OCC lives on PUT draft only); success POST returns `{ version }` only;
  no channels `returnTo` (built console-side); provenance is a derived read;
  approvals / control-blocks / drift-as-refusal are NOT publish gates;
  no rollback reason field exists (RollbackDto carries no reason key —
  the rollback itself is audited as `assistant.rolled_back`).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
