# C07. Guardrails — PLAN (STATUS: FINAL 2026-09-18)

> Ledger protocol followed: VERIFY (§1 + §8) → RESEARCH (§2) → PLAN → design SVGs → code.
> No open questions in SPEC — Step 1 instead resolved three copy-traps the SPEC's
> design boxes walk into (§8). Nothing below contradicts a verified bind.

## 1. Verified engine truth (every claim with `file:line`)

- `guardrail_policy` = exactly 4 fields, nothing else (`engine/src/modules/assistants/validation.ts:94-110`):
  `input_policy` string min(1) default `'default'`; `output_policy` string min(1)
  default `'brand-safe'`; `pii_redaction` boolean default true;
  **`execution_mode` `blocking|logging` default `blocking`**.
- The flip is a definition change (new draft, auditable), never a silent toggle;
  mode is handed to Studio in the authorized context; enforcement is Studio-side;
  engine versions the contract + emits the policy span (`validation.ts:98-108` comment).
- Runtime assembly (`engine/src/modules/conversations/mcp-authority.service.ts` —
  NOTE: moved out of `assistants/` since the SPEC was written, §8.1):
  run.context span carries policy IDENTIFIERS ONLY, verdicts Studio-resolved (:1962-1965);
  `pii_redaction === false` → piiOff (:2001); legacy snapshots resolve `blocking` (:2002-2007);
  context hands `{inputPolicy, outputPolicy, piiRedaction, executionMode}` (:2340-2345);
  span attrs `guardrail_input_policy/_output_policy/_execution_mode/_pii_redaction` (:2348-2353).
- Policy resolution is a CLOSED behavioral vocab (`engine/src/common/guardrails/moderation.ts:148-162`):
  `'off'`/`'disabled'` → direction DISABLED (no provider call); `'strict'` → screen +
  block on `flag`; `'default'`/`'brand-safe'`/ANY unknown string → screen, block on `block` only.
  Verdicts `allow|flag|block` (:21). Block writes `GUARDRAIL_BLOCKED` RunWarning + fails
  the run (:12-13). Configured-provider failure fail-closed in prod (:93-99).
- Control blocks = SEPARATE system, owner/admin only:
  GET/POST/DELETE all `@Roles('owner','admin')` (`control-blocks.controller.ts:17-47`);
  reason mandatory 1–512 (:52 of `control-blocks.service.ts`), `expires_at` ISO-or-null (:59),
  LIST_CAP 200 (:22), `createdBy` = actor sliced 128 (:72). No warn mode exists.
- Platform template-blocks are staff-only rows in a DIFFERENT table/system
  (`fleet.staff.controller.ts:12,57-103`, kill/lift) — they NEVER appear in the org
  `GET control-blocks` list (§8.4).
- Studio contract guardrails: input enum `[default, strict, permissive]`, output enum
  `[brand-safe, default, strict]`, pii boolean; NO execution_mode, NO patterns, NO thresholds
  (`products/agent-studio/contracts/agent-definition/v1.schema.json:149-170`).
- Console gaps C07 closes (`console/neryva-website/src/lib/engine/agent-payload.ts`):
  `ConsumerDefinition.guardrails` = `{pii_redaction, input_policy, output_policy}` only (:69-73);
  `toWire` drops guardrail execution_mode (:208-212 — always engine default);
  `parseAssistantPayload` drops it on read (:358-362). AgentEditor panel has PII + two
  free-text areas, no mode control (`AgentEditor.tsx:504-531`). `sectionOf` has no
  guardrail case → 422s misattribute to `instructions` (`setup-caps.ts:209-232`).
- Builder pre-state: `guardrails` satellite kind exists, shortcut `G`, blurb
  `What this agent may never do` (`slot-model.ts:68-75`); `g` summon-or-focus wired
  (`AgentBuilder.tsx:384`); `kindDraftEmpty` guardrails → false, born-ready (:57-59);
  projector placeholder `Platform defaults` + `Mode control lands in C07` (`projector.ts:585-590`);
  `SLOT_PASS.guardrails = C07` (`BuilderInspector.tsx:71`); detail page has an inline
  guard list, not a panel (`AgentDetailView.tsx:319-339`).

## 2. Research synthesis (finding → decision)

- R1. Measure-then-flip is the industry rollout spine: log-only shadow first, tune
  false positives against real traffic, THEN enforce; gate config treated as versioned
  code with review, never console-tweaked at 2am (pulserevops.com enterprise guardrails
  guide 2026-08; ai-tldr shadow-mode guide 2026-06: pre-register gates, 24–72h minimum).
  → The mode control states its consequence inline: flipping = new draft, auditable;
  logging copy = "records verdicts — nothing is refused"; blocking copy = "refuses
  violating content". Never presented as an instant toggle.
- R2. Statement-of-reasons transparency: every enforcement names the rule, how it was
  decided, and its impact; 165M DSA appeals with ~30% reversal prove unexplained blocks
  don't survive scrutiny (getstream.io 2025-12; scalevise 2026-08; confir.eu AI Act Art 50).
  → Every C07 surface names policy + direction + consequence in plain words. No appeal
  endpoint exists in the engine → appeals are a stated NON-GOAL (§10), not a dead button.
- R3. PII-redaction scope honesty: redaction runs at ingest/write time and is NEVER
  retroactive; best practice marks filtered content with an unmistakable envelope signal
  (Laminar PII docs; toolrouter PII-filter docs 2026-04; orq.ai `on_failure: block` default).
  → PII toggle carries the whisper "applies to new runs from publish — past runs keep
  what they stored" (true: versions are immutable, policy is per-version). PII-off carries
  explicit consequence copy ("identifiers reach storage, logs, and the provider").
- R4. Guardrail config as versioned code (R1 source) reinforces the engine's own law
  (flip = new draft). → Simple/Advanced split: Simple = presets with consequences stated;
  Advanced = mode + custom policy names with resolved-behavior readout, so a custom name
  can never silently mean something the maker didn't intend.

## 3. Builder placement

- Existing `guardrails` SATELLITE (no new slot kind; `slot-model.ts` stays closed).
  Shortcut `G` pre-wired — no collision, no change. Color `#FF9F0A` shared with memory
  (pre-existing; not C07's to fix).
- `GuardrailsSection`: Block A Protection (input preset select, output preset select, PII
  switch + non-retroactivity whisper); Block B Execution mode (blocking|logging segmented
  control + logging-vs-blocking indicator + flip-consequence copy); Block C Advanced
  (custom policy-name free text per direction with resolved-behavior readout).
  Simple-vs-Advanced = a local view switch (default Simple), not two slots.
- Save machine: the proven one (`useAssistantDefinition` draft edit, debounce 8000ms,
  full-payload PUT, 409-adopt, 412 merge-or-reload, dirty flag, Escape-blur).

## 4. Pure model first (`builder/lib/guardrails-model.ts`)

- `GuardrailExecutionMode = 'blocking' | 'logging'` (default `'blocking'`); garbage → default (C06 precedent).
- `POLICY_PRESETS`: input `[default, strict, off]`, output `[brand-safe, default, strict, off]`;
  custom names allowed (engine min(1), unknown → standard screening) but NEVER offered as
  `permissive` preset — contract `permissive` resolves to standard screening engine-side,
  so a Permissive preset would lie (§8.3).
- `resolvePolicyBehavior(name)`: SINGLE display mirror of `moderation.ts:148-162`
  (`off|disabled → disabled`, `strict → strict`, else `standard`), each behavior carrying
  its plain-words consequence string. One derivation, tested, cited — never per view.
- `gradeGuardrails({input, output, pii, mode})` truth table: `logging` → attention
  ("Logging — verdicts recorded, nothing refused"); any direction disabled → attention
  naming the direction ("Input screening off — violations pass through"); else ready
  (`Blocking · PII on` style summary). No draft → ready `Platform defaults` (born-ready kept).
- `filterBlocks(blocks, {target, status, query})` pure helper for the Blocks gaps.
- Copy constants: `MODE_COPY`, `PII_NON_RETRO_COPY`, `OFF_CONSEQUENCE_COPY`, `FLIP_COPY`
  (flip = new draft, auditable). Bounds: policy min 1; blank = engine default (console
  convention: `''` → omitted → `default`/`brand-safe`); reason 1–512 (blocks, unchanged).

## 5. Hooks (extend existing; exact functions)

- `agent-payload.ts`: `ConsumerDefinition.guardrails += execution_mode: GuardrailExecutionMode`
  (required-with-default, C06 precedent); `EnginePayload.guardrail_policy += execution_mode: string`;
  `defaultConsumer()` gains `execution_mode: 'blocking'`; `toWire` ALWAYS sends it explicitly
  (explicit toggle, never silent fallback — knowledge_policy precedent); parse maps
  `logging`→logging else blocking. Tests: round-trip, garbage-default, always-sent.
- `useAgentAuthoring.ts`: `AgentDefinition = ConsumerDefinition` inherits automatically; no change.
- `AgentEditor.tsx` Guardrails panel: add mode segmented control + `<FieldIssues
  messages={issuesBySection.get('guardrails')} />` (parity so the editor can author the flip).
- `setup-caps.ts`: add `case 'guardrail_policy': return 'guardrails'`; update the
  `setup-caps.test.ts:126` assertion that pins the OLD misattribution (owned change, §8.5).
- `useSetupOperate.ts`: NO new hooks (list/set/clear exist with invalidation). BlocksView
  consumes `filterBlocks` from the pure model instead of a new derivation.

## 6. Projector + page deltas (grading truth table)

- Replace the `guardrails` placeholder case (`projector.ts:585-590`) with `gradeGuardrails`
  output: subtitle = mode + policy summary (e.g. `Logging · in default / out brand-safe`,
  `Blocking · input off`); status ready/attention; hint names the fix path
  (logging → "Flip to blocking when false positives settle — a new draft";
  off → "Pick a preset to re-enable screening"). No-draft branch keeps `Platform defaults`/ready.
- NO bottom-action rule: guardrail policy does not gate publish (required-checks render in
  C14; control-block refusals surface there too). A hint here would invent a block.
- Detail: NEW read-only `GuardrailsPanel` (BrainPanel precedent) REPLACING the inline list
  at `AgentDetailView.tsx:319-339` (same dock, stagger kept): mode badge
  (blocking dot-success / logging dot-warning + "records verdicts — nothing is refused"),
  per-direction rows with resolved behavior (`strict — also refuses borderline content`),
  off-direction warning rows, PII row with non-retroactivity whisper, `Edit in builder →` link.
  Watch-out law honored: NOTHING implies engine-side blocking for logging verdicts.

## 7. Variants & gates

- Empty: no draft → satellite `Platform defaults`/ready (born-ready, never ghosted);
  Blocks empty → existing honest empty state kept.
- Loading: projector neutral-while-loading (existing pattern); QueryView skeletons.
- Error: QueryView error states; typed engine errors via `toastEngineError` (existing).
- Denied: viewer role → section read-only + role explanation (proven pattern); Blocks page
  keeps the `setup:govern` gate (owner/admin) with request path; NO per-row Clear guard needed (§8.4).
- Conflict: 409-adopt + 412 merge-or-reload via the save machine; control-block create
  409 (`active platform block` is staff-side; org duplicate → validation message rendered).
- Role matrix: guardrail policy edit = owner/admin/developer (draft-edit); control blocks
  CRUD = owner/admin (server-enforced, UI-explained); reads = all roles.

## 8. Corrections log (SPEC deltas found in Step 1)

- 8.1 SPEC cite drift: `mcp-authority.service.ts` moved `assistants/` → `conversations/`;
  cited lines renumbered (run.context span :1962-1965, legacy-blocking :2001-2007,
  context handoff :2340-2345, span attrs :2348-2353). Binds hold verbatim.
- 8.2 SPEC design boxes over-promise: NO denied-patterns / custom-patterns / thresholds
  exist in validation, contract, or resolver — the 4-field policy + 3-behavior resolver is
  the whole system. Design restated: presets + custom NAMES with resolved readout (§4).
- 8.3 `brand-safe` ≡ `default` behaviorally (resolver treats both as standard screening);
  contract `permissive` input ≡ standard screening too (resolver doesn't know it). Only
  `off`/`disabled` truly disables. UI never claims distinct behavior; `permissive` not offered.
- 8.4 Ledger §C07 "read-only guard for staff template rows" gap is VOID: platform blocks
  live in a separate staff table and never enter the org list; the page already gates on
  `setup:govern` (owner/admin). Real Blocks gaps: target/status filters + search, expiry
  futurity validation, `Expires-in-N` status, permanent-block confirm, createdBy/At columns.
- 8.5 `sectionOf('guardrail_policy.*')` → `instructions` misattributes 422s; C07 adds the
  `guardrails` case and updates the pinning test (owned change, both files cited in §5).

## 9. Dedicated surface plan

- (a) Blocks `/agent-studio/blocks` — KEEP + EXTEND (`BlocksView.tsx`, 217 lines, shell +
  govern gate + table + create modal + clear confirm kept). Gaps to close (§8.4 list):
  target/status filter + search (via `filterBlocks`), row `Clear` per-row pending (today one
  mutation flag freezes ALL rows — C06 ToolsView precedent: per-row pending id), expiry
  `datetime-local` picker with futurity validation (ISO free-text today), `Expires-in-N`
  pill (binary Active/Expired today), confirm dialog for no-expiry permanent blocks,
  Created by/at columns (parsed but unrendered). `describeBlockExpiry` kept single-source.
- (b) Per-agent policy — NEW read-only `GuardrailsPanel` on detail (§6); it gets NO library
  page (policy is per-version truth, like brand).
- Non-goals for Blocks: staff platform-block rows (different system, no read verb for org
  roles), block editing (no update endpoint — clear + re-set is the real path, stated in copy).

## 10. Explicit non-goals (enterprise honesty)

- Denied-pattern / threshold authoring (no engine fields — §8.2).
- Appeals/review queue for verdicts (no engine endpoint; R2's transparency is met by
  statement-of-reasons copy, not a dead Appeal button).
- Retroactive PII redaction (versions immutable; whisper states it — R3).
- Warn mode on control blocks (doesn't exist; reason mandatory).
- Per-tool/per-direction PII scope (policy is per-agent booleans + names).
- Any trace/operate copy implying engine-side blocking for logging verdicts (the C07 lie).

## 11. Query-key + invalidation plan

- Guardrail policy rides the EXISTING draft cache: `useAssistantDefinition` under
  `[...AUTHORING_KEY, orgId, ...]` (`useAgentAuthoring.ts:99,164`); saves use the proven
  `If-Match` edit path (:374-386) with `AUTHORING_KEY` invalidation (:317,350). No new cache.
- Blocks: existing `[...OPERATE_KEY, orgId, 'blocks']` read (`useSetupOperate.ts:270`);
  set/clear already invalidate it (:293,303). C07 adds no keys — filters are client-side
  over the cached list (single source, no fork).
- No health/catalog reads needed (policy is self-contained — lighter than C05/C06).

## 12. Shortcut impact

- NONE. `G` summon-or-focus pre-exists (`AgentBuilder.tsx:384`); no new key, no moved key.
- Escape guard GAINS `guardrailsDirty` alongside the five existing flags (:365) — same
  blur-instead-of-unmount contract. No shortcut-map lock test (no add/move; that test lands
  with C09 per the protocol's Wiring item).
