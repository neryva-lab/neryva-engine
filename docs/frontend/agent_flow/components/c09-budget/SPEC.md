# C09. Budget — SPEC (STATUS: NOT STARTED)

> Design position: Brain/Safety advanced (plain words, never hidden in JSON only). Depends on: C01.

## Engine binds (verified 2026-09-17)

- `budget_policy` (all optional): max_total_tokens 1000–2,000,000; max_cost_micros 0–1,000,000,000,000; wall_clock_seconds 0–86,400 (24h); max_tool_calls 0–1000; **max_model_calls 1–200 (min 1 — no "disable" control)** (`validation.ts:33-41`).
- Absent dimensions fall back to manifest defaults; Studio enforces what the manifest serves.
- Cost preview where priced; unpriced labeled, never zero-implied. **Cache-split display (P2)**: cached vs uncached input costs; lone-half derivation rules are engine-side — UI renders the reported split.
- Wall-clock breach fails the run closed (FAILED + terminal event + quota release): the Try wall-clock-stop line in C13 traces to this.

## Design (fill in the C09 pass)

- [ ] Plain-words caps (spend/conversation, tool calls, model calls, tokens, wall clock) with engine ranges as field bounds.
- [ ] Estimate line (model pricing) vs unavailable label; cache-split line where reported.
- [ ] Unset = platform defaults (stated).

## Open questions

- Costs-read route fields: cite exact response keys during the pass (costs route exists per P2 record; bind, don't guess).

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
