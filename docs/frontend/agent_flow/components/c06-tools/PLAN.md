# C06. Tools — PLAN (STATUS: FINAL)

> Position: behavior section. Depends on: C01. Builder invents no tools — catalog attach only.
> Method: engine-first verification (2026-09-17, all file:line cited) + enterprise UX
> research (MCP permission patterns, shadow-first rollout, hash-pinned change detection),
> then this plan. Designs: `design_tools_sidebar_dark.svg` + `design_tools_section_dark.svg`.
> Build order below is mandatory: model → hooks → projector → section → wiring → library → gates.

## 1. Verified engine truth (no inventions; corrections to SPEC logged in §8)

- **Entries**: `tool_policy.tools[]`, **contract max 32** (engine allows 50,
  `validation.ts:85` — 32 wins, README #2). Per entry (`validation.ts:68-87`):
  `name` engine min 1 max 64, NO regex; `access` read|write; `approval`
  required|optional default optional; `schema_hash` 64hex optional;
  `execution_mode` live|shadow default live.
- **Name rules RESOLVED (SPEC open question — answered, no longer open):**
  CATALOG names `^[a-z][a-z0-9_]{1,63}$` (`tool-catalog.service.ts:47,434`;
  console `TOOL_NAME_PATTERN` mirrors it). CONSUMER entry names: contract
  `^[a-z0-9_]+$` min 2 max 64 (engine imposes nothing; contract governs shape,
  min wins over engine's 1). NEVER enforce a leading letter on entries
  (README #12 stands — neither engine nor contract has it).
- **Approval mapping is CENTRAL and verified** (`manifest-resolution.service.ts:241-244`
  for built-ins, `:291-294` for rows; console `effectiveApproval` in
  `agent-payload.ts:132-143`): `entry.approval === 'required'` OR catalog
  `approvalRequirement === 'REQUIRED'` → REQUIRED else NONE/optional. tools-model
  imports the console mapping — one module, never per view.
- **Drift rejects, typed** (`manifest-resolution.service.ts:256-268`): missing or
  disabled row → `tool pins rejected: <name>: not present…or disabled`; hash
  mismatch → `…schema_hash does not match…(pin is stale)`. Re-pin = set the
  entry's `schema_hash` to the live row hash. Built-ins skip pin checks
  (`web_search, request_human_handoff, generate_image, search_knowledge,
  search_memory` — `useSetupTools.ts:24`).
- **Perimeter (P4), first-class** (`tool-catalog.service.ts:94-165`):
  environments in_process|sandboxed_microvm|external_gateway; egress 1–32 bare
  hostnames; in_process forbids http_binding AND egress lists; binding host must
  be covered (absent list defaults to exactly the binding host — recorded, never
  silent). Publish pins the perimeter from the live row; authorize denies on
  drift (`manifest-resolution.service.ts:271-302`, `mcp-authority.service.ts:1376+`).
- **Shadow**: entry-level `execution_mode`; authorize carries the shadow flag and
  the runtime returns a marked-simulated result, executing nothing
  (`mcp-authority.service.ts:1382,1408`). Shadow NEVER gates (C10 law).
- **Roles, verified** (`tool-catalog.controller.ts`): catalog/templates/detail GET
  all roles; upsert/from-template owner/admin/developer; `PATCH :name/enabled`
  owner/admin. Catalog rows never expose sealed credentials
  (`useSetupTools.ts:7-9`); binding shows fingerprint-only state, never secrets.
- **Approvals are runtime-only**: `GET /console/org/:orgId/approvals?state=`
  (owner/admin/developer) + extend (owner/admin) (`approvals.controller.ts:20-42`);
  decisions at `POST :runId/approvals/:approvalId/decision`. NO per-agent filter,
  NO pre-approve endpoint exists — builder "inline" = requirement display +
  deep link to `/agent-studio/approvals` (stated, never faked).
- **Console gap (this pass closes it):** `ConsumerTool` + both payload mappings
  (`agent-payload.ts:30-35,162-175,286-299`) DROP `execution_mode` — shadow is
  unauthorable from every console surface today. C06 extends the type + mappings
  + tests. Effect classes closed: `TOOL_EFFECT_CLASSES` (console) =
  READ_ONLY|MUTATING|DESTRUCTIVE.

## 2. Research synthesis (finding → decision)

1. **Classify by side-effect; approval is orthogonal** (MCP permission literature,
   2026): read-only vs read-write vs destructive × auto vs approval-gated. The
   engine already separates effect_class (row) from approval (entry∨row) — the
   UI renders the EFFECT × APPROVAL matrix per row, never conflates them, and
   lints effectful-without-approval as legal-but-flagged (ToolsView already does;
   builder rows repeat the lint, same copy).
2. **Shadow-first rollout** (egress/shadow literature: "deploy in shadow, measure
   on your own traffic, then enforce"): `execution_mode: shadow` is presented as
   "Measure first, enforce later" with a flip-to-live action — the enterprise
   rollout path for mutating tools, exactly as the engine intends it.
3. **Hash-pinned change detection** (gateway literature: hash contract, quarantine
   on difference): stale pins render as drift rows with the exact typed message
   + one-tap Re-pin (entry hash := live row hash). Never a silent auto-update.
4. **Deny-by-default egress with binding-host coverage** (Permit/Azure/Kars
   literature): perimeter block shows effective environment + egress list +
   binding-host coverage state; in_process shows "no egress surface".
   No learn-mode, no ephemeral grants — the engine has neither; not designed.
5. **Approval-queue card laws** (ledger §4 C06, researched 2026-09-17): payload-diff
   cards, one-tap decide, reject-requires-note, inline execution, reversibility
   gating, fatigue tuning. Apply to builder approval rows (display + link) and
   the C15 queue; verify decision-note support in Step 1 of C15, not here.
6. **Discovery ≠ authorization** (catalog literature): the Tools library governs
   discovery; authorize-time enforces. Builder rows show BOTH the pin state and
   the computed authorize-time approval mode (`effectiveApproval`), labeled as such.

## 3. Builder placement (dedicated section, no compromises)

- Satellite kind `tools` EXISTS (lilac `#A78BFA`, shortcut `T`, right column).
  No new kind, no shortcut change. Canvas satellite renders bound rows
  (name · effect · approval · shadow · pin state) + `+ Bind from catalog`.
- `ToolsSection` (inspector, dedicated, own file + styles + tests) with four blocks:
  - **A. Bound entries (≤32)** — rows: `name · version · effect pill ·
    approval mode (computed via effectiveApproval, labeled "at authorize") ·
    execution mode (live|shadow badge) · pin state (vN ✓ | stale → re-pin |
    missing/disabled → typed message) · access (read|write) · perimeter whisper
    (effective env + egress count)`. Row actions: Unbind (draft-local, microcopy
    "Removes the entry. The catalog row stays."), Shadow↔Live flip, Re-pin
    (stale only), access flip, approval flip. Built-ins (no row needed) attach
    directly with in_process posture stated.
  - **B. Bind from catalog** — searchable inventory (`GET tools` rows + built-ins):
    effect/approval/enabled filters; each row shows pin-ability (disabled rows
    marked, never bindable — publish would refuse); Bind writes entry
    `{name, access: read, approval: <chosen>, schema_hash: <row.hash>,
    execution_mode: live}` (hash pin ALWAYS set for rows — unpinned binds are
    drift on arrival; built-ins carry no hash). Cap-32 hold named.
  - **C. Perimeter (read-mostly)** — per bound row: effective environment
    (row value, else `external_gateway` historical posture — NEVER labeled
    in_process by default), egress allowlist with binding-host coverage ✓/✗,
    in_process rows state "no egress surface". Editing environment/egress =
    catalog writes → deep link to Tools library (org writes, govern where
    applicable). Authorize-denies-on-drift stated once.
  - **D. Approvals consequence** — approval-required rows: "Calls pause for a
    human in Approvals" + deep link (`/agent-studio/approvals?state=pending`) +
    extend/expiry truth (TTL lives on the runtime request, stated). No inline
    decide (nothing exists to decide pre-runtime — §1).
- Detail page: read-only `ToolsPanel` (entries + authorize-time modes + pin
  states + perimeter, deep-links out, zero writes) — mirrors C04/C05 panels.

## 4. Pure model first — `lib/tools-model.ts` (+ `.test.ts`, ranges green first)

- `validateToolName` (entry rule: 2–64 `^[a-z0-9_]+$`, no leading-letter — with
  the catalog/entry split documented); `validateCatalogName` (catalog rule
  `^[a-z][a-z0-9_]{1,63}$`, re-export-equivalent of TOOL_NAME_PATTERN — single
  source stays in useSetupTools; model asserts parity by test).
- `validateEntries` (≤32, unique names, per-entry shape); `canBind` (cap-32 hold).
- `approvalMode(entryApproval, catalogRequirement)` — THIN wrapper over
  `effectiveApproval` (import, don't duplicate) returning `{mode, source}` where
  source ∈ entry|catalog|default (labeled in UI: "required by entry" vs
  "required by catalog").
- `pinState(entry, catalogRow | null, isBuiltIn)` → ready(stale? no: pinned vN) |
  stale(live vM) | missing | disabled | builtin | unpinned-row (row without hash:
  legal but drift-on-arrival — lint, not block).
- `perimeterLabel(row | null, isBuiltIn)` → effective env + egress + coverage
  (in_process → "no egress surface"; null row → external_gateway historical).
- `moveTool` (bounds-clamped reorder — order is display + authorize-list order;
  publish doesn't prioritize tools, stated once, no fallback fantasy).
- Copy constants: `UNBIND_COPY`, `SKIP_COPY` reuse, `SHADOW_COPY`
  ("simulated — executes nothing"), `DRIFT_COPY`, `NO_APPROVAL_PREVIEW_COPY`
  ("Calls pause for a human in Approvals — nothing to decide until runtime.").

## 5. Hooks (extend, don't duplicate)

- Reuse `useToolCatalog`, `useToolTemplates`, `useUpsertTool`,
  `useToolFromTemplate`, `useSetToolEnabled` (add NOTHING except: parser carries
  perimeter fields IF the list endpoint returns them — verify in build;
  absent → null, never invented; perimeter block degrades to "catalog default"
  copy. Catalog detail `GET :name` exists for the drawer if needed).
- Draft save: entries ride the existing draft machine (`If-Match`, uuidv7,
  409-adopt, 412 dialog). `ConsumerTool` + `toEnginePayload`/`fromPayload`
  extended with `execution_mode` (default live on send when absent — engine
  default stated; read tolerantly).
- Approvals read for the consequence block: reuse the approvals list query
  (org-level, pending) — display counts only if cheap; else static link. Decide
  in build, no extra endpoint.

## 6. Projector + page deltas (pure, tested)

- `toolsSlot(definition, catalog | undefined)` exported helper: usability grade —
  `ready` (entries all pinned-fresh, or zero entries = "No tools — deliberate");
  `attention` (stale pin with live version | missing/disabled row — "publish
  refuses" + fix); `info` (catalog loading → neutral; unpinned-row binds →
  "drift on arrival" lint); built-ins always ready.
- Subtitle: `N bound` + suffix (`· 1 stale` / `· shadow on M` / `· covered`).
  Leg to `brain` lights when entries > 0 (existing rule — keep).
- Bottom-action: NO new rule (knowledge 4c precedent reviewed — tools attention
  surfaces via the satellite + readiness at C14; adding a rule per satellite
  would crowd the bar. Record the decision here so C07+ don't relitigate).
- `slot-model.ts`: untouched (kind exists). Empty-card hint already lists `T`.

## 7. Variants & gates (README component gate, all mandatory)

- Empty (no entries — deliberate-state copy), loading (catalog/health neutral),
  error (typed engine errors verbatim), permission-denied (author vs govern:
  bind/edit = author; enable-toggle + catalog writes = govern; viewers read +
  request path), conflict (409 name-taken on install/clone paths, 412 stale,
  422 dotted-paths + secret-shape), stale/disabled/missing pins, shadow,
  unpinned-row lint, cap-32 hold.
- Tests: model (ranges/names/mapping/parity/pins/perimeter) → payload mapping
  (execution_mode round-trip) → hooks (parser/perimeter tolerance) →
  projector (grading truth table) → section (4 blocks + variants + save) →
  wiring. Gates ONCE at end per ledger Step 5.

## 8. Corrections log (SPEC § + binds, verified 2026-09-17)

- (a) **Perimeter default is `external_gateway`, NOT `in_process`**
  (`tool-catalog.service.ts:101`; migration 0066 backfills external_gateway as
  historical posture, `manifest-resolution.service.ts:271-274`). SPEC's
  "(default in_process)" holds ONLY for built-ins (resolved in_process + [],
  `:250-251`). UI shows the EFFECTIVE environment, never a default claim.
- (b) **Leading-letter RESOLVED**: catalog names REQUIRE leading letter
  (`tool-catalog.service.ts:47,434`, console `TOOL_NAME_PATTERN`); consumer
  entry names contract-only (`^[a-z0-9_]+$`, min 2 — engine min 1, no regex).
  Two objects, two rules, both enforced in the right place. README #12 stands.
- (c) **Console drops `execution_mode`** (`agent-payload.ts:30-35,162-175,286-299`)
  — C06 extends type + both mappings + tests, or shadow stays unauthorable.
- (d) **Builder "request/approve inline" = display + deep link.** No pre-approve
  endpoint exists; approvals are runtime-only, org-level, no per-agent filter
  (`approvals.controller.ts:20-42`). SPEC's inline line is honored as
  requirement-row + pending-state link, never a faked decide button.
- (e) **`effectiveApproval` understated one cell — FIXED in this pass.**
  `({never}, REQUIRED)` returned `'optional'`, but authorize enforces REQUIRED
  whenever the row demands it (`manifest-resolution.service.ts:291-294`; the
  Tools library's own pin-discipline copy already states "regardless of the
  version entry"). Fixed in `agent-payload.ts` + its test (catalog REQUIRED now
  always wins); `AgentEditor` inherits the correction through the same function.
  tools-model wraps it with source labels, never a parallel mapping.

## 9. Dedicated Tools library page — KEEP + EXTEND (no rebuild, no new route)

- Keep: shell, built-ins panel, catalog table, Upsert/FromTemplate modals,
  pin-discipline explainer, role gates, `QueryView` patterns.
- C06 closes (audited 2026-09-17): catalog filters/sort (effect/approval/enabled);
  row drawer (edit pre-fill via upsert, version history, re-pin action wiring
  `CopyPinButton` → real flow); per-row pending (kill the global switch lock);
  `rateLimit` named validation (replace silent clamp); clipboard-failure path;
  perimeter columns (effective env + egress count — only if the list endpoint
  returns them; else link to detail `GET :name`).
- No new route, no nav move. Page stays at `/agent-studio/tools`.

## 10. Explicit non-goals (enterprise honesty)

- No catalog authoring in builder (upsert/from-template stay in the library;
  builder links out — org writes with govern splits don't belong in a draft flow).
- No learn-mode / ephemeral egress grants (engine has neither).
- No per-action approval TTL editing (TTL lives on runtime requests; C15 owns
  extend semantics).
- No credential display, ever (fingerprint-only states where the engine reports them).
- No evaluation/shadow analytics (shadow RESULT review is C13/C10 territory).
- No served-answer tool-call claims (no per-run tool source field verified).

## 11. Query-key + invalidation plan

- Reads: `['studio','setup','tools',orgId,'list']` (30s stale, shared with library
  — builder warms it unconditionally like documents); templates (5min, lazy on
  drawer open); approvals pending (only if the consequence block shows counts).
- Writes: draft save → `['studio','assistants']` (existing machine); catalog
  enable/upsert → existing `useInvalidateTools` (TOOLS_KEY scope).
- No new root keys. No N+1 (one catalog read per surface, shared cache).

## 12. Shortcut impact

- None. Kind `tools` keeps `T`; empty-card hint unchanged. No lock-test change.
