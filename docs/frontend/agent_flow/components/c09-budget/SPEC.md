# C09. Budget — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: Brain/Safety advanced (plain words, never hidden in JSON only). Depends on: C01.

## Engine binds (verified 2026-09-17)

- `budget_policy` (all optional): max_total_tokens 1000–2,000,000; max_cost_micros 0–1,000,000,000,000; wall_clock_seconds 0–86,400 (24h); max_tool_calls 0–1000; **max_model_calls 1–200 (min 1 — no "disable" control)** (`validation.ts:33-41`).
- Absent dimensions fall back to manifest defaults; Studio enforces what the manifest serves.
- Cost preview where priced; unpriced labeled, never zero-implied. **Cache-split display (P2)**: cached vs uncached input costs; lone-half derivation rules are engine-side — UI renders the reported split.
- Wall-clock breach fails the run closed (FAILED + terminal event + quota release): the test-run wall-clock-stop line in C13 traces to this.

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Plain-words caps (spend/conversation, tool calls, model calls, tokens, wall clock) with engine ranges as field bounds.
  5 rows with engine bounds + per-row unset-vs-zero whispers (cost 0 ≡ unset =
  unenforced, stated loudly; wall/tool 0 → defaults; model min 1 structural).
- [x] Estimate line (model pricing) vs unavailable label; cache-split line where reported.
  Rough estimate at uncached rates (labeled, never the bill); cached-input unit price
  shown ONLY when the cost point reports it (never derived — no usage split is
  reported anywhere, so the line is a price line, stated as such).
- [x] Unset = platform defaults (stated).
  Exact served matrix per dimension (200k/120s/16/8; cost-unchecked) + fail-closed
  law (FAILED + terminal event naming the dimension + quota release) + publish note.

## Costs-route fields (open question answered 2026-09-18)

- `GET /console/org/:orgId/models/costs` (all roles) → `{costs: [{provider, model,
  costMicrosPer1kInput, costMicrosPer1kOutput, costMicrosPer1kCachedInput|null,
  currency, effectiveFrom}]}` — latest effective unretired point per model.
  Console gap closed: cached price parsed + labeled (was dropped).

## Open questions

- ~~Costs-read route fields: cite exact response keys during the pass (costs route exists per P2 record; bind, don't guess).~~
  ANSWERED 2026-09-18 — see "Costs-route fields" above.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
