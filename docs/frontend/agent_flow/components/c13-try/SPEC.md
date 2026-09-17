# C13. Try — SPEC (STATUS: NOT STARTED)

> Design position: "Speak to it" (draft test). Depends on: C01, C02, C04 (needs a usable model).

## Engine binds (verified 2026-09-17)

- Test runs: `POST .../versions/:versionId/test-runs` (`assistants.controller.ts:215-227`). `run_kind='test'`: no quota reservation, no billable usage, never user-visible (`assistants.service.ts:1444-1491`).
- Prerequisites (UI gates, engine truths): draft exists; ≥1 usable model attached (engine availability reasons, C04); instructions advisory-only for test (publish requires them, test does not).
- Streaming: existing SSE pattern (accepted→runId→stream, silence hint). Failure states: provider error + retry; **cost-stop** ("budget limit exceeded") and **wall-clock-stop** (P2 `failRunForBudget`: FAILED + terminal event + quota release) as SEPARATE lines; run-plane-quiet check-status line. Draft always intact.
- Trace drawer (honest "what it saw — not proof of why"): retrieved chunks (title + excerpt + score + version/pin state), directive paragraph, tool calls (name + approval + effect + result|simulated-for-shadow), guardrail verdicts (policy + verdict + mode indicator — logging verdicts must not read as blocks), model used, tokens/cost + cache split where reported. Causality highlighting BARRED.
- Reload mid-try: draft restores from server; thread restores only if the engine persisted it — say so, never invent persistence.

## Design (fill in the C13 pass)

- [ ] Thread (user/agent bubbles, streaming skeleton, citation affordance, input dock).
- [ ] Prerequisite blocks with per-reason fixes (no model → choose/connect; empty instructions → advisory whisper).
- [ ] Trace drawer sections + Edit jumps + re-ask loop + Adjust return (draft + thread preserved).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
