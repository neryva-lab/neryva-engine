# C13. Test run — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: test the draft (in-builder phase). Depends on: C01, C02, C04 (needs a usable model).

## Engine binds (verified 2026-09-17)

- Test runs: `POST .../versions/:versionId/test-runs` (`assistants.controller.ts:215-227`). `run_kind='test'`: no quota reservation, no billable usage, never user-visible (`assistants.service.ts:1444-1491`). Prompt text required, 1–8192 chars (`assistants.controller.ts:229-231`).
- Prerequisites (UI gates, engine truths): draft exists; ≥1 usable model attached (engine availability reasons, C04); instructions advisory-only for test (publish requires them, test does not).
- Streaming: existing SSE pattern (accepted→runId→stream, silence hint). Failure states: provider error + retry; **cost-stop** ("budget limit exceeded") and **wall-clock-stop** (P2 `failRunForBudget`: FAILED + terminal event + quota release) as SEPARATE lines; run-plane-quiet check-status line. Draft always intact.
- Trace drawer (honest "what it saw — not proof of why"): retrieved chunks (title + excerpt + score + version/pin state), directive paragraph, tool calls (name + approval + effect + result|simulated-for-shadow), guardrail verdicts (policy + verdict + mode indicator — logging verdicts must not read as blocks), model used, tokens/cost + cache split where reported. Causality highlighting BARRED.
- Reload mid-try: draft restores from server; thread restores only if the engine persisted it — say so, never invent persistence.

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Thread (user/agent bubbles, streaming skeleton, citation affordance, input dock).
  Multi-turn session thread (role bubbles + streaming skeleton bubble +
  reported-hit citation chips + multiline dock with send↔stop + New try);
  transcript stays the record, live tail is the overlay.
- [x] Prerequisite blocks with per-reason fixes (no model → choose/connect; empty instructions → advisory whisper).
  Ordered blocks (no-version / no-model with Brain fix / instructions
  advisory whisper with Purpose jump naming the publish refusal); usable
  count reuses the catalog read, never a new derivation.
- [x] Trace drawer sections + Edit jumps + re-ask loop + Adjust return (draft + thread preserved).
  Shared common-UI Drawer (C10/C15 reuse, never fork): reported-only
  retrieval, draft-sourced directive, tool calls incl. shadow-simulated,
  guardrail rows with logging≠block, reported-only usage + no-bill-row
  note, separate FAILED wall-clock stop line. Re-ask re-posts a fresh
  draft-pinned run (never engine regenerate); Edit jumps select builder
  slots / link to the builder; draft untouched, thread in `?try=`.

## Corrections (found in Step 1 — see PLAN.md §8 D1–D6)

- Controller cite spans `:215-233`; its message over-claims the 1..8192
  range (lower bound only — the service owns the upper bound).
- No engine cost-stop exists: token/cost caps enforce Studio-side. The
  "SEPARATE lines" contract holds in copy — the wall-clock line is
  engine-bound, cost lines render only from Studio-reported events.
- "Never user-visible" is unenforced engine-side: UI states only no
  quota / no billing / draft intact, never invisibility.
- Per-run excerpts/scores/version-pin state are not durably reported:
  the trace renders only arriving events; the directive comes from the
  draft (labeled); guardrail verdicts are Studio-reported.
- The thread IS engine-persisted; today's loss was a client pointer bug —
  fixed via `?try=`, with honest restore copy.
- Every send is a fresh test-run POST: follow-up messages and regenerate
  resolve through the published pointer and would silently leave the
  draft pin (`conversations.service.ts:377-394`, `regenerateMessage`
  uses `pickVersionPin`). Re-ask re-posts; those endpoints are never
  called from Try.

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
