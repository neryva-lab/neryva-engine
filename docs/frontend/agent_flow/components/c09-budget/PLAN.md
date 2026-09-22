# C09. Budget — PLAN (STATUS: FINAL 2026-09-18)

> Ledger protocol followed: VERIFY (§1 + §8) → RESEARCH (§2) → PLAN → design SVGs → code.
> The SPEC's open question is ANSWERED in §1 (exact keys cited). Nothing below
> contradicts a verified bind.

## 1. Verified engine truth (every claim with `file:line`)

- `budget_policy`, all optional, strict (`engine/src/modules/assistants/validation.ts:33-41`):
  max_total_tokens 1000–2,000,000; max_cost_micros 0–1e12; wall_clock_seconds 0–86,400;
  max_tool_calls 0–1000; **max_model_calls 1–200 (min 1 — no disable control can exist)**.
- Costs read: `GET /console/org/:orgId/models/costs` → `{costs: [...]}` all roles
  (`model-catalog.controller.ts:34-39`); each point = latest effective unretired per
  provider/model (`model-cost.service.ts:123-153`): `{provider, model,
  costMicrosPer1kInput, costMicrosPer1kOutput, costMicrosPer1kCachedInput|null,
  currency, effectiveFrom}`. Console parser (`useSetupModels.ts:87-125`) tolerates
  camel+snake BUT DROPS the cached price (§8.2).
- Served defaults when absent — the exact matrix (Studio compile + live executor):
  tokens 200_000, model calls 16, tool calls 8, wall 120s, cost UNENFORCED:
  - compile (`context-activities.ts:69-72`): calls 16/8, wall `*1000 || 120_000`, tokens 200k;
  - live (`inline-executor.ts:391-398`): tokens `?? 200_000`, cost `?? 0`,
    tools `manifest ?? definition || 8`, wall `> 0 ? deadline : definition max_wall_clock_ms`
    (which itself 0→120s via :242);
  - enforcement (`inline-executor.ts:926-937,939-947`): between-turn breach names the
    dimension (`max_total_tokens|wall_clock_seconds|max_cost_micros`), terminal
    `FAILED_BUDGET` + `BUDGET_EXHAUSTED` event; **cost enforced ONLY when
    `maxCostMicros > 0` AND gateway price > 0** — unset/0 cost = cost-unchecked, structurally.
  - tool-call cap (`:981` `toolCallsExecuted >= maxToolCalls`); model-call min 1 is
    structural (zod rejects 0 — the SPEC's law, confirmed, not just documented).
- Wall-clock fail-closed engine-side too: watchdog cancels past-deadline runs
  (`run-watchdog.worker.ts:14,82`, reason `budget_exceeded_wall_clock`, quota released);
  cancel path mirrors it (`conversations.service.ts:2243-2295`, terminal `budget_exceeded`).
- Cache-split reality: the ONLY cached number anywhere is the cached-input UNIT PRICE
  (`costMicrosPer1kCachedInput`, nullable; staff-written via
  `provider-plane.staff.controller.ts:83,208-211`, validated non-negative
  `model-cost.service.ts:58`). NO per-run cached-vs-uncached usage split is reported
  anywhere (grep: zero hits in engine + Studio runtime). "Renders the reported split" =
  the price line shows the cached price when reported, never derived (§8.3).
- Console state: `ConsumerDefinition.budget` = 5 optionals (cents for cost, seconds
  for wall); toWire maps cents→micros, omits empties; parse reverses
  (agent-payload.ts:74-82,232-240,363-369). Caps checks mirror validation with
  `budget.*` paths (`setup-caps.ts:177-190`) → `budget` section, rendered in the
  editor (`AgentEditor.tsx:551,565`). The editor Budget panel is FULL (5 fields,
  :535-565) — the ledger's "one wall-clock field" line is STALE (§8.4); editor untouched.
- Spend truth: `/agent-studio/usage` (`UsageView`: "Tokens, cost, and quota for your
  agents — measured by the engine, not estimated") — KEEP, linked, never duplicated.
- Builder pre-state: NO `budget` kind in `SlotKind` (slot-model.ts:15); no budget case
  in projector/inspector/`kindDraftEmpty`; palette reads KIND_META/KIND_ICONS
  (both `Record<SlotKind, …>` — compiler guides the extension); StudioShell uses only
  `/` + Escape (§5: `S` free studio-wide); AgentBuilder kindKey `t/g/b/e` (`S` free).

## 2. Research synthesis (finding → decision)

- R1. Breach copy must name the DIMENSION with its own remediation — misclassified
  limiters send users to pay for the wrong thing (claude-code #75730: session vs spend
  message; hackerai #753: structured abort reasons + no blind Continue).
  → Every cap row states its breach consequence; the section states the fail-closed
  law once (FAILED + terminal event + quota release). Breach names the dimension
  because the runtime does (`budgetBreach()` returns it; event carries it).
- R2. Enforcement vs observability: dashboards don't stop spend; the in-path cap does
  (ravoid 2026-09: $47K loop; SDK max_iterations as the primitive).
  → Copy frames caps as run-stopping (fail-closed), never as alerts. Measured spend
  (Usage, engine-measured) and estimates (model pricing, rough) are visually and
  verbally separated — the estimate line is labeled "rough, not the bill."
- R3. Cache accounting: meter reads/writes/uncached separately; `input × standard
  rate` overstates up to ~10x on cache-heavy workloads (usagebox LiteLLM LIT-3771;
  dev.to 6 price components; jsonhouse/aicost: 90% read discount, 1.25–2x write
  premiums). → The estimate uses uncached rates, is labeled rough, and shows the
  cached-input unit price ONLY when the cost point reports it (never derived —
  the lone-half rule). No usage-split display exists to show; the cache line is a
  PRICE line, stated as such (§8.3).
- R4. Quotas are product + unset≠zero must read explicitly (tianpan quotas 2026-05:
  opacity tax, soft-before-hard, tier matrix).
  → The unset-vs-zero matrix is rendered per row, not footnoted: tokens/wall/calls
  unset → named platform defaults (200k/120s/16/8); cost unset OR 0 → "No spend cap —
  runs are cost-unchecked" (the `> 0` gate makes 0 ≡ unset — stated, the highest-risk
  row gets the loudest copy); wall 0 → 120s default (NOT instant-fail — the `||`
  compile); tool 0 → 8. Model calls expose no 0 (min 1 — the control cannot exist).

## 3. Builder placement

- NEW `budget` SATELLITE: `slot-model.ts` gains the kind (label `Budget`, blurb `Cost
  and time guardrails`, color amber `#FF9F0A`? — taken by memory+guardrails; pick
  distinct: teal `#64D2FF`? iOS teal, unused in KIND_META — verify against canvas-only
  accents at build time; pass `C09`), KIND_ORDER appended after `brand`? Order is
  canvas order — append last (additive, never reorder). NOT skippable (platform
  defaults are runtime truth — guardrails precedent). `BUILDER_STEP_ANCHORS +=
  budget: 'budget'`. `columnFor`: right column (default branch covers it — knowledge-
  likes stay left; no change needed, verified §1).
- Shortcut `S` (free studio-wide and in-builder, §1) + the FIRST shortcut-map lock
  test (`slot-model.test.ts` NEW: full shortcut→kind map pinned + uniqueness).
- `BudgetSection`, 3 blocks: (A) Caps — 5 plain-words rows (spend/tokens/tool/model
  calls/wall clock) with engine bounds + per-row unset-vs-zero whisper + breach
  consequence; spend row in dollars (cents UI ↔ micros wire, existing mapping);
  (B) Estimate — per allowed-model lines (unit prices in/cached-in/out or `unpriced`;
  cached line only when reported) + rough-total line vs unavailable label;
  (C) Fail-closed note (breach law) + Usage deep-link (measured spend).
- Save machine: the proven one (`useAssistantDefinition`, 8000ms, full-payload PUT,
  409-adopt, 412 dialog, dirty, Escape-blur). Caps ride `budget` (all-optional —
  UNSET to uncap, never 0-for-unset except where 0 ≡ default anyway).

## 4. Pure model first (`builder/lib/budget-model.ts`)

- `BUDGET_BOUNDS` mirroring validation (tokens 1000–2M, cost micros 0–1e12, wall
  0–86400, tools 0–1000, models 1–200) + `PLATFORM_DEFAULTS` (the served matrix:
  tokens 200_000, cost null-unchecked, wall 120s, tools 8, models 16) — each default
  cited to its compile line. `describeCap(key, value)`: set → `12,000 tokens` style;
  unset → `Platform default (200,000)`; cost unset/0 → `No spend cap — cost-unchecked`;
  wall 0 → `120s default`; tools 0 → `8 default`.
- `validateCaps(budget)`: single mirror of setup-caps budget checks for the
  held-messages path (paths `budget.*`, same messages — one derivation; the section
  filters `budget.*` like siblings do).
- `estimateRun(tokens, cost)`: `(in+out)` at uncached rates → micros + `rough` flag;
  `formatMicros` ($x.xx / $x.xxxx under $1? — match `costLabel` precision: 4dp $/1k);
  cached price shown via `cachedLabel(cost)` or null (never derived).
- `gradeBudget(budget, costs?)`: cost-cap set + priced models → ready
  `Capped · ~$x rough`; cost unset → ready `No spend cap` (ready, not attention —
  deliberate config, stated loudly, C05 retrieval-off precedent); all unset → ready
  `Platform defaults`. No attention state (breach proneness is C15 observe territory).
  No draft → ready `Platform defaults` (born-ready).
- Copy: `FAIL_CLOSED_COPY` (FAILED + terminal event + quota release + dimension named),
  `ESTIMATE_COPY` (rough, not the bill; uncached rates; cache price only when reported),
  `UNSET_COPY` per row, `PUBLISH_COPY` (budget-only edits publish — prompt/params rule
  cousin: manifest excludes NOTHING budget-side… verify: budget rides version writes —
  it does (toWire budget_policy); copy: "Budget edits ship with the version — publish
  to serve them." — safe, no C14 dependency claimed).

## 5. Hooks (extend existing; exact functions)

- `useSetupModels.ts`: `ModelCost += costMicrosPer1kCachedInput: number | null`
  (parse camel+snake, §8.2); `cachedCostLabel(cost)` (price or null — never derive);
  existing `costLabel` untouched. Tests: cached parse + label-null behavior.
- `agent-payload.ts`: NO shape change (mapping verified §1). Tests: budget unit
  round-trip already covered — add explicit-zero-cost case (0 stays 0 on the wire,
  NOT omitted — `budget.max_cost_cents: 0` must survive: verify toWire keeps 0!
  `if (def.budget.max_cost_cents !== undefined)` — check: line 234 uses !== undefined
  ✓ keeps 0. Test pins it.)
- `setup-caps.ts`: NO change (checks mirror validation already). No test change.
- No new query keys: costs read reuses `['studio','setup','models',orgId,'costs']`
  (BrainPanel/ModelsView warm it — single source).

## 6. Projector + page deltas (grading truth table)

- ADD `budget` case with `gradeBudget` (subtitle `Capped · ~$2.40 rough` /
  `No spend cap` / `Platform defaults`; hint: '' except cost-unset →
  `Set a spend cap or link measured spend.`? — NO: that invents advisory pressure.
  Hint stays '' (no fix path exists for deliberate config); the Usage link lives in
  the section/panel, not the hint.
- `kindDraftEmpty += budget → false` (defaults truth; exhaustive switch guides it).
- NO bottom-action rule (budget never gates publish).
- Detail: NEW read-only `BudgetPanel` (BrainPanel precedent) — caps with
  unset-vs-zero resolution, estimate lines per allowed model (or `unpriced`),
  fail-closed note, `Open Usage (measured) →` + `Edit in builder →`. No new library
  page (policy is per-version truth, like guardrails).

## 7. Variants & gates

- Empty: no draft → `Platform defaults`/ready; no allowed models → estimate block
  states "Pick a model in Brain — estimates need a priced model." (never a fake $0).
- Loading: projector neutral; costs loading → estimate skeleton (never `unpriced`
  flash — `unpriced` renders only on loaded-absent).
- Error: costs error → estimate error whisper + caps still save ("Prices unreachable —
  caps above still save; estimates resume on reload.").
- Denied: viewer read-only + role explanation (pattern); no govern-only control here
  (draft-edit roles only).
- Conflict: 409-adopt + 412 dialog via save machine.
- Role matrix: budget edit = owner/admin/developer; costs read = all roles; no new gates.

## 8. Corrections log (SPEC deltas found in Step 1)

- 8.1 SPEC open question ANSWERED: exact keys
  `{provider, model, costMicrosPer1kInput, costMicrosPer1kOutput,
  costMicrosPer1kCachedInput|null, currency, effectiveFrom}` + `{costs}` envelope,
  all-roles read. Console gap: cached price dropped — C09 adds it.
- 8.2 SPEC "cache-split line where reported" RESTATED: no usage split is reported
  anywhere — the line shows the cached-input UNIT PRICE when the cost point carries
  it, else nothing (never derived — the lone-half rule honored by omission).
- 8.3 Unset-vs-zero matrix nailed per dimension (§1 table): cost 0 ≡ unset
  (unenforced — loudest copy); wall/tool 0 → defaults (120s/8); model min 1 structural.
- 8.4 Ledger "only one AgentEditor wall-clock field" is STALE — the editor Budget
  panel is full (5 fields). Decision: KEEP the editor (untouched) + builder quick
  path; no extend-or-replace dilemma remains.
- 8.5 `max_cost_cents: 0` must survive toWire (verified `!== undefined` keeps it) —
  pinned by test (an omit-if-falsy refactor would silently uncap spend).

## 9. Dedicated surface plan

- KEEP platform Usage (`/agent-studio/usage`) + Billing for spend truth — no changes,
  deep-linked (`Open Usage (measured) →`). No per-agent library page.
- NEW `BudgetPanel` on detail (§6). Non-goals: spend charts per agent (Usage owns
  measurement), budget editing outside builder/editor (two surfaces already), what-if
  simulators (no engine endpoint — an estimate is not a simulator).

## 10. Explicit non-goals (enterprise honesty)

- Usage-split cache display (nothing reported — §8.2); derived cached prices (banned).
- Per-run spend attribution in the builder (Usage owns measurement; estimates ≠ bills).
- Budget alerts/notifications (no engine endpoint).
- Cost-cap enforcement claims beyond fail-closed (between-turn breach + watchdog —
  verified; nothing about pre-emption or tool-plane atomicity is claimed — R1's
  action-plane gap is Studio's, not ours to narrate).
- Editing caps for viewers / new roles (roles rendered, never silent).

## 11. Query-key + invalidation plan

- Caps ride the EXISTING draft cache (`AUTHORING_KEY`, `useAssistantDefinition`;
  If-Match edit path). No new cache.
- Costs: EXISTING `['studio','setup','models',orgId,'costs']` read (staleTime 5m);
  C09 adds zero keys, zero invalidations (list prices are staff-written, read-only).
- No health/knowledge/catalog reads (self-contained + costs, like C07 + prices).

## 12. Shortcut impact

- NEW `S` → budget (collision-checked: free studio-wide + in-builder, §1).
- FIRST shortcut-map lock test: `slot-model.test.ts` pins the FULL map
  (`N` palette-note? — no: only canvas kind keys + ⇧K/⇧M + the registry in ledger §5:
  `t/tools, g/guardrails, b/brand, e/evaluation, s/budget, ⇧K/knowledge, ⇧M/memory`)
  + uniqueness + KIND_META parity. Future add/move MUST update it (stated in file).
- Escape guard GAINS `budgetDirty` (seventh flag) — same contract.
