# C11. Templates — PLAN (STATUS: FINAL 2026-09-18)

> SPEC: `engine/docs/frontend/agent_flow/components/c11-templates/SPEC.md`
> (MODEL RESOLVED, NOT STARTED). Ledger: `components/ledger_component.md` §C11.
> Governing model: **Template = contract. Pins = fulfillment. Eval = proof.**
> Every engine claim below was read firsthand on 2026-09-18 (two subagent
> sweeps + direct reads). Paths repo-root-relative (`neryva_studio/`),
> console paths prefixed `console/`.

---

## 1. Verified engine truth (file:line)

### 1a. Registry source (ledger correction CONFIRMED)

- `products/agent-studio/templates/registry.json` is BUILD INPUT only
  (envelope, 20 rows today — a snapshot, never a contract; engine caps
  `LIST_CAP = 200`, `engine/.../templates.service.ts:76,347`).
- CI `engine/src/scripts/sync-template-registry.impl.ts:13-16` upserts
  `assistant_templates` (global, no RLS) once per release.
- Console reads the DB via `GET /console/org/:orgId/assistant-templates`
  (`console/.../useSetupTemplates.ts:185`;
  `engine/.../templates.controller.ts:13,18-24`), roles
  owner/admin/developer/reader/billing (`:19`). Detail
  `GET :slug?version=` same roles (`:26-28`).
- List entry = `{template, available, compatibility{status,
  reasons[{code,detail}]}, installed, update_available}`
  (`templates.service.ts:62-70`).
- Row columns mirror the envelope (`sync-template-registry.impl.ts:33-44`
  → `131-142`); statuses CHECK-constrained `stable|beta|deprecated`.
- **Parser DRIFT (must fix):** live rows serialize camelCase
  (`evalRef, releasePolicy, minEngineSchema`) but the console parses
  snake_case (`useSetupTemplates.ts:135-138`) → the three parse to null
  on live responses. List-level fields are snake_case both sides — fine.

### 1b. Install TX (order + codes CORRECTED vs SPEC)

- No dedicated endpoint: install = `POST assistants {template:{slug,
  version?}}` (`assistants.controller.ts:15-30` → `templates.install()`),
  roles owner/admin/developer (`:16`). Console `useCreateAssistant`
  (`useAgentAuthoring.ts:332-359`).
- Actual order (`templates.service.ts:198-323`): `get()` (404) →
  `minEngineSchema` guard → **platform block 403 BEFORE validation
  (`:213-220`)** → unknown-keys → payload validation → name
  default=slug, trim, 2–128 (`:230-233`) → hash → `preResolveToolPins`
  (pre-TX) → TX{ org template-block check → assistant → version →
  install row → outbox } → audit.
- **Codes are 400, not 422** (`ApiError.validation` = 400): every "422"
  in comments is aspirational. **409s hold** (org template-block
  `:249-254`; name collision `:306-311`). Platform block is **403**.
- DRAFT v0 verbatim (`version: 0, status: 'DRAFT'`, `:259-276`);
  instructions nullable (`:271`); install row
  `{organizationId, slug, templateVersion, assistantId, installedBy}`
  (`:277-286`); outbox `template.install_provisioning`
  `{install_id, assistant_id, template_slug, template_version,
  definition_hash}` (`:287-300`); audit `template.installed`
  (`:313-321`); description auto-set verbatim
  `` `Installed from template ${slug}@${version}` `` (`:257`); active
  pointer untouched (insert carries no `activeVersionId`).
- **Q2 decided:** description writeable ONLY at creation
  (`dto.ts:32-35`); install IGNORES caller description; NO patch route
  exists (controller inventory: no `PATCH/PUT /assistants/:id`).
  Post-install description is immutable. The wizard's description input
  is engine-discarded — rewire it (see §9).

### 1c. Compat (advisory, 4 codes)

- Exact codes (`templates.service.ts:44-48`):
  `required_model_capability_missing | required_tool_missing |
  knowledge_source_missing | provider_credential_missing`;
  statuses `COMPATIBLE | INCOMPATIBLE` (`:55-58,470`).
- Advisory proof: `list()` annotates all rows, filters none
  (`:100-111`); install never consults compatibility. Console
  `reasonFix` maps all 4 to live routes (`useSetupTemplates.ts:215-228`).

### 1d. installed / update_available + drift inputs

- `installed` = org has ≥1 install row for the slug (`:107`).
- `update_available` = semver compare of org installs vs latest-per-slug
  (`:108-109,571-583`); downgrade/unparseable → `none`.
- `checkUpdates()` has NO route — feeds `getVersionProvenance`
  (`assistants.service.ts:1111-1118`).
- Drift UI inputs are console-readable: provenance
  `{template{slug,version,definition_hash}, manifest_hash,
  update_available, ...}` (`assistants.service.ts:1090-1150`;
  `useVersionProvenance` + `parseProvenance`,
  `useAgentAuthoring.ts:192-225`) vs live registry detail
  (`GET assistant-templates/:slug?version=`).

### 1e. Blocks (two layers; list carries none)

- Org `control_blocks` `target_type='template'`, name `slug` (all) or
  `slug@version` (one release); exact-version wins; active =
  `expires_at IS NULL OR > now()` (`control-blocks.service.ts:136-141`).
  Enforced in-TX → **409** (`templates.service.ts:246-254`).
- Global `template_platform_blocks` (staff-written)
  → **403** pre-validation (`:210-220`) + rollout pointer guard.
- List carries NO block field — console matches client-side
  (`matchTemplateBlock`, `useSetupOperate.ts:263-277`, exact-then-slug)
  over `GET control-blocks` (owner/admin only). Viewers can't read
  blocks — install-time 409/403 + viewer copy cover them.

### 1f. Provisioning (Q3 decided: NO progress read)

- Trigger: install TX outbox row → `OutboxDispatcherWorker` →
  `TemplateProvisioningConsumer` (`template-provisioning.consumer.ts:43-44`).
- SPEC I7 "states" DON'T exist: identity commits synchronously in one TX;
  the consumer runs 3 steps in one TX (tool re-verify, knowledge-seed
  check, eval-dataset seed, `:56-95,97-228`). Only generic outbox states
  exist (PENDING→CLAIMED→PUBLISHED / RETRY_WAIT / DEAD_LETTER).
- **No poll route, no SSE, no status field** for provisioning (SSE is
  run/conversation-only). Post-install UI live-reads the fulfillment
  inputs (catalog / documents / models) — the checklist pattern — and
  NEVER polls a nonexistent endpoint or fakes phases.

### 1g. Q1 decided: adoption = re-install-as-new

- No apply/migrate/upgrade/reinstall endpoint exists (exhaustive search).
  Doctrine, twice: "never auto-migrate — runs stay pinned"
  (`templates.service.ts:325`); "Upgrade guidance is always 'new draft
  from vX.Y.Z'" (`assistants.service.ts:1083-1088`).
- Action: `update_available` major/minor → **"Install vX.Y.Z as new
  assistant"** (same `useCreateAssistant`, new version) + a definition
  diff (`diffDefinitions`, `useAgentAuthoring.ts:295-314`) — never an
  in-place button. Re-install confirm names the duplication (SPEC
  gallery binds).

### 1h. Datasets / templateRef / channels / required-objects

- Seed convention `template:<slug>@<version>` in all three places
  (consumer `:151,158`; eval `:577-590`; assistants `:1056-1068`).
- Snapshot `templateRef{slug,version,definition_hash}`
  (`manifest-resolution.service.ts:116-120,468-497`; persisted
  `:1649-1668`).
- Channels `{channels[], caps}` fail-open + defensively filtered
  (`templates.service.ts:167-196`); render read-only until channels ship
  (locked — console type `useSetupTemplates.ts:59`).
- All 20 rows: `required = ["safety_pass","tool_authorization_pass",
  "schema_valid",{"regression_no_worse_than":0.02}]` — objects bind as
  the regression bound (`eval.service.ts:710-743`); gate string-filters
  then joins (`release-gate.ts:96-98`). UI: strings verbatim, objects in
  plain words/JSON (C10 established; reuse, never re-derive).

### 1i. Console reuse points (firsthand)

- `useSetupTemplates.ts` full read: parsers tolerant (`94-179`);
  `reasonFix` correct (`215-228`); `BindingTool` has NO version/hash
  expectation (`42-48`) — tool-drift compare keys on catalog liveness,
  not a template pin (see §5.4).
- `TemplatesView.tsx` full read (807 lines): FilterBar `269-284`
  (slug+family search `:250`); cards `299-376` (installed static `:311`,
  blocked banner `:344-355` gated on block-read, Install always enabled
  `:360-368`); DetailModal 6 tabs `393-601` (eval slice-5 `:565-569`,
  ReleaseTab object-safe `:590`); InstallWizard `603-698` (name 2–128,
  description input ENGINE-DISCARDED `:617,629`, incompatible-allow
  `:680-685`, 409 hint `:687`, success → checklist `:694` + editor link
  `:657`); PostInstallChecklist `700-807` inline (4 confirmed bugs §8).
- `useCreateAssistant` (`:332-359`): `{name, description?, template?,
  definition?}` → `{assistantId, versionId, ...}` + AUTHORING
  invalidation; toast-only errors.
- Tool catalog rows carry `version/hash/enabled`
  (`useSetupTools.ts:33,37,38`); documents carry `sourceSlug/state`
  (`useSetupKnowledge.ts:40-46`).
- Builder: gallery link exists ONCE (`PurposeInspector.tsx:234-236`);
  palette has no template kinds by design; `kindDraftEmpty` untouched.
- Detail: NO template rows anywhere (only `EvaluatePanel:57-61` reads
  `releasePolicy.required` as a dataset hint); versions diff modal
  exists (`AgentDetailView.tsx:599-636`, `diffDefinitions`).
- `installed` entries carry NO `assistantId` — installed→agent routing
  is unbuildable without an endpoint (platform ask, §10).

---

## 2. Research synthesis (finding → decision)

> Web-backed 2026-09-18 (6 deep results). Sources: Kore.ai marketplace
> design, agentmarketplace.ai, AIHive, Arahi, aiagentics, CAST/Netwrix/
> CrewAI preflight, gaia compatibility.py, ARX preflight, MATIH
> provisioning, PostHog wizard FAB, StarterPick onboarding, Dusko
> tenant-provisioning, brotcode onboarding, vstorm/goldpath/templui
> upgrade guides. Each maps to a C11 decision; research never overrides §1.

- R1 (atomic card: function/context/compat at a glance — Kore.ai):
  cards communicate what it does + what it needs + compat WITHOUT
  opening. → D: card keeps slug@version + status + compat + reasons;
  ADD "what you get" BOM counts (tools/knowledge/models/eval) from the
  entry — never a data grid (SPEC gallery binds).
- R2 (preview-before-install: scope/integrations/sample flows —
  Kore.ai/agents): confidence turns into commitment before touching
  anything. → D: keep 6-tab DetailModal; ADD eval untruncate control +
  live Channels state; keep advisory-never-hiding.
- R3 (editorial curation ≠ engine data — Kore.ai New/Featured):
  curation is static UI config, never presented as data. → D: no
  featured flags invented; family pills + counts bind to reads; search
  extends to description/tools/knowledge/evaluators (all in-entry).
- R4 (preflight: blockers vs warnings; untestable = NAMED warning —
  CAST/Netwrix/gaia/ARX): installs refuse on blockers with the reason +
  fix; warnings proceed with degraded capability stated; anything that
  cannot be probed becomes a warning naming the gap, never a silent
  pass. → D: compat stays advisory (engine truth); install-time
  403/409/400 render verbatim with per-row fix paths; checklist rows
  distinguish loading (skeleton) vs error (retry) vs gap (fix) vs done
  — the 4 confirmed bugs die here.
- R5 (provisioning: no fake progress; one active item; unblock early —
  dispatchseo/PostHog/MATIH): long work shows live checklist ticks,
  never invented phases; user proceeds while work continues. → D: NO
  phase stepper (I7 states don't exist — D-correction); post-install
  shows the fulfillment checklist reading LIVE inputs immediately
  (builder opens at once, draft editable); dead-letter surfaces as the
  I8 banner with what-failed + Retry + requirements (no outbox read —
  failure inputs re-read: pins/docs/models).
- R6 (checklist > rigid wizard; progress is org state, not session —
  StarterPick): return out of order, see why each task matters, skips
  stored. → D: checklist rows carry fix actions + deep links, completable
  out of order; nothing prefilled is ever re-asked (SPEC matrix law).
- R7 (upgrade: manual, diff-first, reversible, manifest bumps last —
  vstorm/goldpath/templui): plan report (new/auto/kept/conflicts),
  dedicated branch + undo, "safe to overwrite" vs "merge carefully"
  classes. → D: adoption = "Install vX.Y.Z as new" + definition diff
  (`diffDefinitions`, added/removed/changed rows) + never-auto-migrate
  copy + re-install-duplication confirm. No in-place anything.
- R8 (one pipeline, two entries; idempotent observable steps —
  Dusko/brotcode): same function, different callers; double-submit
  returns first result. → D: install POST stays idempotent
  (already is); builder origin reuses the SAME wizard contract, never a
  second install path.

---

## 3. Builder placement (origin surface, shortcut)

- Ledger decision: origin-mode gallery INSIDE the builder; exact mount
  decided in PLAN with options, not assumed. DECISION: **builder
  new-mode start screen** (not a right-inspector section — install is an
  origin choice, and the inspector mounts only after selection; not a
  palette kind — palette kinds are slot singletons by design).
  - New mode currently = Purpose form only. The origin screen offers
    two paths: "Start blank" (existing Purpose form) vs "Start from
    template" (gallery grid → detail → install → I1 transition into
    build mode with the prefilled map + badge + checklist).
  - Rationale: install creates the assistant (needs no prior selection);
    the response/try precedent (spine, no shortcut) doesn't apply —
    origin is pre-circuit. The single existing gallery link
    (`PurposeInspector:234-236`) stays as the secondary path.
- No new shortcut, no moves: `E` remains evaluation; gallery is
  pointer-driven. Lock test untouched.
- Post-install map state lives in build mode: badge (`slug@version` +
  provenance) + repair checklist — rendered as a builder banner/panel,
  NOT an inspector satellite (no new SlotKind — vocab stays closed).

---

## 4. Pure model first (`builder/lib/template-model.ts` + test)

- `TEMPLATE_NAME_{MIN,MAX} = 2/128` (bind §1b; client mirrors, server is record).
- `validateTemplateName(name)`: trim → length check → same one-tap-rename copy as C01.
- `describeInstallOutcome(error)`: ApiError → I2–I6 rows:
  409 + name-taken message → rename (overlay stays, nothing created);
  403 → platform-blocked whisper (reason, NOT retryable);
  409 + template-blocked message → org-block whisper + Blocks path;
  400 + unknown/disabled-tool detail → tool whisper (admin-enable OR pick-another);
  400 + registry-definition detail → registry-bug copy (no user fix);
  `minEngineSchema` client check → disabled card BEFORE click (I6).
  Copy never names codes — it names fixes. (Codes verified §1b.)
- `describeUpdateAction(updateAvailable)`: none → silent; minor → info
  "improvements available"; major → attention "new major version" +
  "Install vX.Y.Z as new assistant" (Q1 — never upgrade-in-place).
- `renderRequiredCheck(check)`: REUSE C10's `describeRequiredCheck`
  (import — never a second derivation; C11 depends on the same shapes).
- `describeCompatEntry(entry)`: {compatible, reasons with fix links}
  — thin over existing `reasonFix` (import).
- `describeTemplateCounts(template)`: BOM counts
  {tools, knowledge, models, evaluators} for "what you get".
- `checkTemplateDrift(installed, registry)`: compares provenance
  template{slug,version} + manifest hash vs live detail row →
  {upToDate | minor | major | registryGone} + diff link labels.
  Pure semver-compare over `update_available` + version strings.
- Copy constants: `INSTALL_*` (I1 success, I7 provisioning honesty —
  "copies now, fulfills async", I8 failure), `REINSTALL_COPY`
  (duplication confirm), `NEVER_LIVE_COPY`, `ADVISORY_COPY`,
  `Q2_COPY` (description immutable — wizard input removed, see §9).

---

## 5. Hooks (extend, never duplicate)

1. **Fix `parseRegistryTemplate` camelCase** (`useSetupTemplates.ts:135-138`):
   accept `evalRef|eval_ref`, `releasePolicy|release_policy`,
   `minEngineSchema|min_engine_schema`. Same query, same key — additive
   tolerance (the C10 parser pattern). Unblocks eval tab, thresholds,
   required checks on LIVE responses. + tests (camel fixture).
2. **No new install mutation**: `useCreateAssistant` stays the single
   install path (idempotent ✓). Builder origin + gallery wizard share it
   (R8 — one pipeline, two entries).
3. **No provisioning-status query** (Q3 — none exists; never invent one).
   Checklist reads catalog/documents/models/health (existing hooks).
4. **Drift/update reads**: `useVersionProvenance` + `useAssistantTemplate`
   (both exist) — no new queries. `update_available` arrives on list
   rows + provenance.
5. **`BindingTool` stays pin-free**: the template carries no pinned
   hash/version (bind §1i) — tool-drift compare keys on catalog
   liveness (missing/disabled/changed-hash-vs-install... vs WHAT? The
   install-time pin is unreadable post-hoc EXCEPT the fresh v0
   definition entries, which carry `schema_hash` when resolved).
   → Checklist tool states: missing (no row) / disabled (row exists,
   enabled false) / changed (entry `schema_hash` present AND ≠ live
   hash → re-pin) / resolved. No `schema_hash` on the entry → resolved
   or missing/disabled only (stated in code comment — never guessed).

---

## 6. Projector + page deltas (grading truth table)

- NO new slot kind, NO spine change, NO grade change: templates are an
  ORIGIN, not a circuit component. The canvas is untouched by C11
  (origin screen lives pre-circuit; post-install map is a banner/panel
  above the circuit, not a node).
- Post-install map state: builder banner (new, `TemplateBanner`):
  `slug@version` badge + provenance (installs.templateVersion +
  snapshot templateRef via existing provenance read) + repair-checklist
  entry + update banner slot. Shown when the open assistant has a
  template install (provenance.template non-null).
- Update banners (builder + detail, SPEC lifecycle): none → silent;
  minor → info badge; major → attention badge; action = "Install
  vX.Y.Z as new" + diff view (`diffDefinitions` rows added/removed/
  changed — reuse `DiffModal` pattern from AgentDetailView, never a
  second differ).
- No bottom-action rule (install/publish gating is C14's; the banner
  links to PublishPanel instead of duplicating refusal copy).

---

## 7. Variants & gates (empty/loading/error/denied/conflict + roles)

- Empty: registry empty (mirror-empty copy kept); no installs (gallery
  is the CTA); template without evalRef/policy (legacy copy kept).
- Loading: checklist sub-queries render SKELETONS (fix bug #4 — never
  red X while loading); card grid skeletons (existing QueryView).
- Error: sub-query error → row-level retry (not a gap); install I2–I6
  verbatim whispers (model §4, overlay stays except I1); I8 dead-letter
  banner (what-failed + Retry + requirements; draft editable, publish
  blocked until resolved — links the publish gate, doesn't re-derive it).
- Denied: install/create gated `setup:author` + denied copy (kept);
  blocks read gated `setup:govern` (kept — viewers get install-time
  409/403 verbatim + viewer copy, never a dead Install).
- Conflict: 409 name-taken → one-tap rename, overlay stays, nothing
  created (C01 pattern); 409 org-block → Blocks path; re-install →
  confirm naming the duplication (SPEC gallery binds).
- Blocked install button: cards disable Install when a READABLE block
  matches (owner/admin); viewers keep the button (can't read blocks —
  409/403 is their backstop, stated).
- Audit: `template.installed` exists — success row links `/platform/audit`
  (README gate; no pre-filter claim).

---

## 8. Corrections log (SPEC deltas found in Step 1)

- D1 (registry path): SPEC `registry.json` is build input, not the
  console read path. Console binds to `GET assistant-templates`
  (DB-backed). Counts/families/statuses bind to reads — "20" is today's
  snapshot, never hardcoded.
- D2 (parser): console parses snake_case; live rows are camelCase for
  `evalRef/releasePolicy/minEngineSchema` → null on live. Fixed in §5.1.
- D3 (codes): install failures are 400, not 422 (all three 422 sites:
  unknown/disabled tool, registry-definition, no-dataset — same
  `ApiError.validation`). Platform block is 403, not 409. Copy names
  fixes, never codes.
- D4 (order): platform-block 403 precedes validation/pins; the org
  template-block 409 is in-TX after pins — not SPEC's
  validation→pins→block sequence.
- D5 (I7 states): the copying→draft→tools→knowledge→eval-states
  machine does not exist. Identity commits in one TX; the consumer runs
  3 steps; only generic outbox states exist. No phase stepper ships —
  the checklist reads live inputs immediately (R5).
- D6 (Q1): no update endpoint — adoption is re-install-as-new + diff.
- D7 (Q2): no description route — immutable post-install; the wizard's
  description input is engine-discarded (removed, §9).
- D8 (Q3): no provisioning progress read exists (no poll/SSE/status).
- D9 (installed routing): list entries carry no `assistantId` — the
  SPEC's "installed badge routes to the existing assistant" is
  unbuildable without an endpoint (platform ask, §10). Re-install
  confirm names the duplication instead.
- D10 (checklist bugs): 4 confirmed correctness bugs fixed in place
  (credentials always-green; hash/version never compared; duplicate
  slugs last-write-wins; loading renders as gaps).

---

## 9. Dedicated surface plan (keep-vs-extend, gaps, non-goals)

- **TemplatesView KEEP + EXTEND** (richest surface, 807 lines):
  FIX all 4 correctness bugs in place (§8 D10); search extends to
  description/tools/knowledge/evaluators (in-entry fields only);
  eval-case untruncate control; live Channels state in the channels tab
  (existing channels hooks — read, don't rebuild); test-run deep-link
  (`chat?agent=` + version pin — TestRunPanel precedent... verify pin
  param support in build; else detail link); blocked-install disable
  for block-readers; update lifecycle (badges + "Install vX as new" +
  diff); re-install confirm; installed badge copy (no route — D9);
  wizard: REMOVE description input (D7 — engine-discarded; replace with
  immutable-post-install whisper), keep name + incompatible-allow +
  409 hint; extract `PostInstallChecklist` as shared component (C06/C10
  rows plug into it per ledger — extraction without behavior change,
  then the 4 fixes land once and propagate).
- Non-goals: publish ceremony (C14); rollout promotion UI (C15);
  approvals payload-diff cards (separate law, no template surface
  owns it); featured curation (static config only if asked — not asked);
  private/internal marketplaces (research context only).

---

## 10. Explicit non-goals + platform asks

- Unbuildable without endpoints (asks, never faked): installed→agent
  routing (D9); candidate promote/reject wiring (C10 D9, unchanged);
  provisioning progress reads (D8); description edit (D7).
- Not built: case browsers, judge configs, cost/latency bands,
  channels write paths, publish/rollout UI, in-place upgrade.

---

## 11. Query-key + invalidation plan

- Read (single-source, existing families): `['studio','setup','templates',
  orgId, ...]` (list/detail); AUTHORING for assistants/versions;
  EVAL_KEY for datasets; catalog/documents/models/health for checklist;
  blocks OPERATE_KEY (existing); notifications (existing).
- Writes: `useCreateAssistant` invalidates AUTHORING (kept) → callers
  ALSO invalidate TEMPLATES list (installed flags!) after install
  success. Datasets refresh via existing invalidation.
- No new family. No second derivation of template truth (parsers fixed,
  not forked).

---

## 12. Shortcut impact

None. No new keys (gallery pointer-driven; `E` stays evaluation).
Lock test untouched (C09's stand).

---

## Build order (§4 protocol)

1. `builder/lib/template-model.ts` + test (name/outcomes/updates/drift/counts/copy first).
2. `useSetupTemplates.ts` camelCase fix + tests (fixture with live keys).
3. Shared `PostInstallChecklist` extract + 4 bug fixes + tests (truthful
   credentials, hash compare, deterministic slugs, loading/error states).
4. Builder origin screen (new-mode start: blank vs template gallery →
   detail → install → I1 transition) + `TemplateBanner` (post-install
   map + update lifecycle + diff) + tests.
5. Wiring: mount decision, install invalidation (TEMPLATES list),
   description-input removal, blocked-install disable, re-install
   confirm.
6. Dedicated extends: search fields, eval untruncate, live channels,
   test-run link, update lifecycle, wizard fixes + tests.
7. Gates once → SPEC flip (answer Q1–Q3 IN the file) + README + ledger
   (§1 row + §7 entry).
