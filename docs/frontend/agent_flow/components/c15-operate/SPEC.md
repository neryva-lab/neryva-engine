# C15. Operate — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: agent detail page AFTER publish (builder remains for future drafts). Depends on: C14. Last component.

## Engine binds (verified 2026-09-17)

- Versions + **lineage**: `parent_version_id` (create = active-at-draft, updateDraft = REBASED onto active, publish inherits, rollback-as-new = restored target); surfaced read-only in provenance (`assistants.service.ts:343-384,460,774,927,1100-1148`).
- Rollouts: weighted variants + pause/resume; paused rows banner `paused_reason/by/at` verbatim (manual = actor, burn-rate = reason+costs; NULL = legacy). Burn-rate is service-only — UI surfaces state + audit, never a burn endpoint.
- **Degraded lifecycle (P5)**: `degraded_until` + `degraded_reason` (≤512) banner; T-24h warn once (`degraded_alerted_at`); past-due auto-suspends via disable (`assistants.service.ts:1708-1773`, `schema.ts:41-43`).
- **Degraded knowledge banner** reads knowledge-health (C05 binds); **drift/shadow badges** (C10 binds); **compromise alerts** (C04 binds).
- Rollback (owner/admin, degraded-ack accepted) restores exact prior behavior; retire read-onlys the version; disable/enable + delete lifecycle-gated (delete 409 until conversations archived: `assistants.service.ts:254`).
- Day-1 emergency UI = exactly two toggles (pause rollout + disable/kill) with confirms. Analytics/anomaly/variant sliders DEFERRED (locked).
- Observe: per-assistant rollups (runs/tokens/cost, containment, CSAT), eval history, run traces, channels, audit log.

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Operate layout (active version, draft status, lineage view, rollouts, evals, cost, blocks, incidents, channels, audit). Agent detail permanently carries install/provisioning state (async provisioning can dead-letter after tab close).
  NEW `OperateHeader` (live card + draft card with `?slot=` resume + lineage strip + single banner + per-assistant channels + spend link-outs + compromise line) above the kept `OperatePanel/ObservePanel/AgentTrail`, with anchor cross-links. Rollout editor, release pointers (+current-pointer read), blocks CRUD, kill switch kept; Resume added (re-set — no resume endpoint). No incident system exists (burn/auto-rollback surface via trail + paused banner); no provisioning progress read exists (dead-letter UI unbuildable — stated).
- [x] Blocks surface: org blocks manageable (owner/admin CRUD: target assistant|version|tool|template|capability, reason 1–512 mandatory, optional ISO expiry) vs platform template blocks read-only; status COMPUTED client-side (Active / Expires-in-N / Expired vs server time — no sweeper).
  Library keeps org rows only (staff read is staff-guarded — read-only rows unbuildable, stated) + member-name Set-by + full timestamps; detail `BlockModal` aligned to datetime-local + futurity + permanent note.
- [x] Approvals destination: aggregate runtime approvals + memory proposals + escalations ONLY if every filter option is provably non-empty; otherwise separate destinations, one visual pattern.
  DECIDED: SEPARATE. Non-emptiness is data-dependent and unprovable; memory has no list read; escalations have no console reads. Queue extended: payload drawer (listable context only), actor+time history, run links, policyVersion, per-row pending, poll-while-pending, deny-requires-reason, loud missing-runId, client search.
- [x] Emergency toggles + degraded/drift/compromise banners with fix paths.
  Exactly two toggles kept; pause confirm names fallback-serving; disable keeps the engine-default reason path; degraded waiver clock bannered (active/due-24h/past-due) with knowledge fix; compromise line reuses the Brain credential read.
- [x] Builder re-entry (new draft → same shell, resume-at-first-incomplete).
  Additive `?slot=` on the build route; operate draft card links first-blocker slot (readiness row→slot map); unknown/unbound values fall through to default selection.

## Corrections (found in Step 1 — see PLAN.md §8 D1–D12)

- No resume route (resume = re-set); pause reason literal `'operator'`
  (actor in `paused_by`); `'ROLLED_BACK'` is enum-historical, never written;
  audit query is exact-match (the old `action:'assistant.'` trail matched
  nothing in production — fixed to newest-100 + client prefix set);
  no per-assistant trace/channel reads; memory/escalations unaggregatable;
  no provisioning progress read; staff blocks unreadable.

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
