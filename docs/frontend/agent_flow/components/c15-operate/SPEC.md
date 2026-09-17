# C15. Operate — SPEC (STATUS: NOT STARTED)

> Design position: agent detail page AFTER publish (builder remains for future drafts). Depends on: C14. Last component.

## Engine binds (verified 2026-09-17)

- Versions + **lineage**: `parent_version_id` (create = active-at-draft, updateDraft = REBASED onto active, publish inherits, rollback-as-new = restored target); surfaced read-only in provenance (`assistants.service.ts:343-384,460,774,927,1100-1148`).
- Rollouts: weighted variants + pause/resume; paused rows banner `paused_reason/by/at` verbatim (manual = actor, burn-rate = reason+costs; NULL = legacy). Burn-rate is service-only — UI surfaces state + audit, never a burn endpoint.
- **Degraded lifecycle (P5)**: `degraded_until` + `degraded_reason` (≤512) banner; T-24h warn once (`degraded_alerted_at`); past-due auto-suspends via disable (`assistants.service.ts:1708-1773`, `schema.ts:41-43`).
- **Degraded knowledge banner** reads knowledge-health (C05 binds); **drift/shadow badges** (C10 binds); **compromise alerts** (C04 binds).
- Rollback (owner/admin, degraded-ack accepted) restores exact prior behavior; retire read-onlys the version; disable/enable + delete lifecycle-gated (delete 409 until conversations archived: `assistants.service.ts:254`).
- Day-1 emergency UI = exactly two toggles (pause rollout + disable/kill) with confirms. Analytics/anomaly/variant sliders DEFERRED (locked).
- Observe: per-assistant rollups (runs/tokens/cost, containment, CSAT), eval history, run traces, channels, audit log.

## Design (fill in the C15 pass)

- [ ] Operate layout (active version, draft status, lineage view, rollouts, evals, cost, blocks, incidents, channels, audit).
- [ ] Emergency toggles + degraded/drift/compromise banners with fix paths.
- [ ] Builder re-entry (new draft → same shell, resume-at-first-incomplete).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
