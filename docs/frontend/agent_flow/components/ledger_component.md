# Component Ledger — agent_flow C06→C15 (FINAL)

> **What this file is.** The single governing ledger for finishing the Studio frontend.
> C01–C05 are SIGNED OFF. Everything remaining (C06–C15) is built from this file,
> one component at a time, in the mandated order (§2). An agent starting any component
> reads this file first, then the component's SPEC, then follows the protocol (§3)
> exactly. No step is optional. No step is reordered.
>
> Paths below are relative to the repo root (`neryva_studio/`), unless prefixed
> `console/` (the website app) or `engine/` (the API + docs).

---

## 1. Done ledger — C01→C05 SIGNED OFF (do not rebuild)

| # | Component | SPEC | Builder surface (right inspector) | Dedicated surface | Locks established |
|---|---|---|---|---|---|
| C01 | Identity | `engine/docs/frontend/agent_flow/components/c01-identity/SPEC.md` | Purpose spine (name set-once, lock glyph) | Agents overview/detail (existing, kept) | Name 2–128, 409 collision, no rename verb |
| C02 | Instructions | `components/c02-instructions/SPEC.md` | Instructions composer (Markdown blocks, verbatim custom, byte-identical round-trip, 8s autosave) | Detail instructions view (kept) | Directive blocks `Role/Task/Rules/Examples/Output/Refusal` |
| C03 | Brand voice | `components/c03-brand/SPEC.md` | Brand satellite (≤2000, platform-default valid, 6th-kind lilac `B`) | Detail brand chip (kept) | First-class version input, blank→NULL→`''` |
| C04 | Brain | `components/c04-brain/SPEC.md` | Brain spine (16 refs max, fallback order, params, presets, credentials) | Models library `/models` (kept) + detail `BrainPanel` (new, read-only) | 3 engine reasons + derived `(derived)` suffix; no served-reality counts |
| C05 | Knowledge | `components/c05-knowledge/SPEC.md` + `PLAN.md` v2 + 2 dark SVGs | Knowledge satellite (`⇧K`, 4 blocks, graded ready/attention/info) + bottom rule 4c | Knowledge library `/knowledge` (kept+extended: paste tab, retention note) + detail `KnowledgePanel` (new, read-only) | Two state machines never merged; contract 16 pins; no retry/delete endpoints (stated, never built); no re-pin button; coverage per-model; retrieval off = deliberate |
| C06 | Tools | `components/c06-tools/SPEC.md` + `PLAN.md` + 2 dark SVGs | Tools satellite (4 blocks: bound/catalog/perimeter/approvals, graded) | Tools library `/tools` (kept+extended: filters, drawer, edit, per-row pending, rate validation, perimeter) + detail `ToolsPanel` (new, read-only) | Entries max 32 (contract wins); catalog REQUIRED always wins in `effectiveApproval`; `execution_mode` required-with-default-live both directions; perimeter default `external_gateway` (built-ins `in_process`); shadow simulates, never gates |
| C07 | Guardrails | `components/c07-guardrails/SPEC.md` + `PLAN.md` + 2 dark SVGs | Guardrails satellite (`G`, 3 blocks: protection/mode/advanced, graded ready/attention) | Blocks `/blocks` (kept+extended: filters/search, Expires-in-N pills, futurity picker, permanent confirm, provenance columns, per-row pending) + detail `GuardrailsPanel` (new, read-only) | 4-field policy only (no patterns/thresholds — SPEC boxes restated); blocking\|logging required-with-default; resolver mirror single-sourced; `brand-safe`≡`default`, `permissive` not offered, only `off` disables; logging never implies blocks |
| C08 | Memory | `components/c08-memory/SPEC.md` + `PLAN.md` + 2 dark SVGs | Memory satellite (`⇧M`, 4 blocks: scope/history/in-scope/org-defaults, always ready) | Memory library `/memory` (kept+extended: search, detail drawer, relative dates, per-row pending, purge entry, policy strip, migrated composer) + detail `MemoryPanel` (new, read-only); KnowledgeView memories block migrated (link left) | 4 scopes, `user` default offered (stale omit-user guidance + false caps issue removed); history serves ≤20 (stated, not capped); NO summary toggle (flag unread); NO proposals inbox (no list endpoint); user rows never previewed in builder; purge real (3–128, tombstone, hash-audit) |
| C09 | Budget | `components/c09-budget/SPEC.md` + `PLAN.md` + 2 dark SVGs | Budget satellite (`S`, 3 blocks: caps/estimate/fail-closed, always ready) + FIRST shortcut-map lock test | Usage `/usage` kept + linked (measured, never duplicated) + detail `BudgetPanel` (new, read-only) | Served-default matrix exact (200k/120s/16/8; cost 0≡unset unenforced, stated loudly); cached price parsed (was dropped), never derived; no usage split exists (price line only); explicit $0 survives the wire; model min 1 structural |
| C13 | Test run | `components/c13-try/SPEC.md` + `PLAN.md` + 2 dark SVGs | Response spine Try console (shared `TryConsole`: prereq blocks, multi-turn thread, dock, `?try=` restore; projector `responseSlot()` grade, usability only) | Detail `TestRunPanel` kept shell + rewritten over the shared console (version picker, fresh thread per version) + shared common-UI `Drawer` (new — C10/C15 reuse, never fork) + shared trace drawer (reported-only) | Every send = fresh test-run POST (follow-ups/regenerate would silently re-pin via published pointer — never called from Try); no engine cost-stop (wall-clock line engine-bound, cost lines reported-only); "never user-visible" unenforced (states only no-quota/no-bill/draft-intact); per-run excerpts/scores not durably reported (trace renders arrivals only); no new shortcut (spine) |
| C10 | Evaluation | `components/c10-evaluation/SPEC.md` + `PLAN.md` + 2 dark SVGs | Evaluation satellite (`E`, stale-first results, seeded-vs-attach, draft-pinned run + same-dataset re-run, shadow/drift states; projector grade + verdict-leg on fresh PASS) | Detail `EvaluatePanel` rewritten over shared `EvalResults` (stale-first, fix-path, re-run) + `EvaluationsView` extended (origin badges, local filters, re-run, results drawer, copy-full) + `DatasetsView` extended (shared origin, attach CTA) | No-dataset refusal is 400 not 422 (copy names the fix); promotion gate separate without shadow exclusion (defers to C15); staleness = timestamp rule (no version hash in provenance — banner shows times, D10); case inputs unlistable (ids+reasons+excerpts only); required objects in plain words (C11-safe); promote/reject stay unwired (no candidate-list endpoint); StartRunModal PUBLISHED-only by design |
| C11 | Templates | `components/c11-templates/SPEC.md` + `PLAN.md` + 2 dark SVGs | Builder origin screen (new-mode start: blank vs template gallery → install → build-mode map banner with badge + drift + update + diff + checklist) | `TemplatesView` slimmed over shared `TemplateGallery` + `InstallWizard` (extended search, eval untruncate, live channels, blocked disable, re-install confirm, description removed) + detail origin row (badge + update adoption + diff) | Console reads DB list, never registry.json ("20" is a snapshot); live rows are camelCase (parser fixed); install codes 400/403/409 (never 422); no update endpoint (re-install-as-new + diff); no description route (immutable); no provisioning progress read (no phase stepper, live checklist); installed entries carry no assistantId (no badge routing — stated); 4 checklist bugs fixed in place |
| C12 | Origins | `components/c12-origins/SPEC.md` + `PLAN.md` + 2 dark SVGs | Builder origin +4 paths (blank/template/clone/import); PurposeInspector build button → shared picker; import creates via single create transport | Shared `ClonePicker` (builder + detail + list, all land on build) + shared `ImportPane` (detail versions + origin; Files\|Paste, dotted issues, schema display, unwrap) + `VersionsPanel` extracted with draft highlight landing | No clone endpoint (client composition); import targets existing DRAFT child (unwrap `.export`); all failures 400; no-op = success or 409 draft_exists; schema neither migrates nor refuses (warn-only); uncovered caps enumerated not duplicated; warn-once persistent dismiss |
| C14 | Publish | `components/c14-ship/SPEC.md` + `PLAN.md` + 2 dark SVGs | Ship spine (verdict-first readiness card + rail + degraded ack + confirm + inline success); projector ship grade; no bottom-action rule, no shortcut | Detail `PublishPanel` rewritten over shared `usePublishReadiness`/`derivePublishReadiness` + shared `PublishSuccess` + typed 409/400 branches; `VersionsPanel` row → review-jump (bypass removed); rollback picker + target preview + ack + live-is-now; channels `returnTo` plumbing | Required set = 6 engine gates only (approvals/blocks/drift-as-refusal are NOT gates — render nowhere); no required-checks endpoint (composed read); no 412 on publish (PUT-draft only); success POST returns `{version}` only (receipt composed); no-op = advisory hint, button stays live; no rollback reason field (unaudited); publish button aria-disabled + scroll-to-first, never dead |
| C15 | Operate | `components/c15-operate/SPEC.md` + `PLAN.md` + 2 dark SVGs | Re-entry only (`?slot=` resume-at-first-blocker; no new section, no shortcut) | NEW `OperateHeader` (live/draft/lineage/single banner/channels/spend links/compromise) + `OperatePanel` extends (resume-as-reset, pointer read, BlockModal datetime, audit link) + `ObservePanel` back-link + `AgentTrail` prefix fix (D8) + `ApprovalsView` extends (drawer, history, per-row pending, polling, deny-reason, runId error, search) + `BlocksView` small (names, timestamps) | No resume route (re-set); pause reason literal 'operator'; ROLLED_BACK enum-historical; audit exact-match (trail was empty in prod); memory/escalations unaggregatable (separate stand); no incident/provisioning/staff-block/per-channel reads (all stated, never faked) |

**C05 is the process template.** Every later component repeats its shape: VERIFY →
RESEARCH → `PLAN.md` → pure model → hooks (extend, never duplicate) → projector
grade → section → wiring (inspector + dirty/Escape + shortcuts) → dedicated
surface → FULL gates → SPEC flip. The C05 PLAN (`components/c05-knowledge/PLAN.md`)
is the format reference for every future `PLAN.md`.

**Established code map (read before touching):**
- Pure models: `console/neryva-website/src/sections/pages/products/agent-studio/builder/lib/` (`slot-model.ts`, `projector.ts`, `bottom-action.ts`, `draft-save.ts`, `*-model.ts` + tests).
- Sections: `builder/inspector/` (`BuilderInspector.tsx`, `*Section.tsx` + `.styles.ts` + `.test.tsx`).
- Page shell: `builder/AgentBuilder.tsx` (queries, keyboard map, dirty guard, bottom bar).
- Detail panels: `agents/detail/*Panel.tsx` (read-only precedent: `BrainPanel`, `KnowledgePanel`).
- Hooks: `console/neryva-website/src/hooks/studio/` (`useAgentAuthoring.ts`, `useSetupKnowledge.ts`, `useSetupConnectors.ts`, `useSetupModels.ts`, `useSetupProviders.ts`, `useAttachmentUpload.ts`).
- Engine truth: `engine/src/modules/` (`assistants/`, `knowledge/`, `config-publish/`, `identity/`).

---

## 2. Mandated build order (no reordering)

`C06 → C07 → C08 → C09 → C13 → C10 → C11 → C12 → C14 → C15`

Why this order and not SPEC order: C10 depends on C13 (evals run against try-able
drafts); C11's repair checklist points at C02/C04/C05/C06/C10 (all must exist first);
C12 is dependency-light but lands after C11 so install-then-clone flows compose;
C14 depends on ALL of C01–C13 (readiness reads every gate); C15 is last (operates
what C14 ships). One component at a time. A component is done only when its SPEC
reads `SIGNED OFF` with a date.

---

## 3. Agent protocol — the exact procedure for EVERY component

### Step 0. Orientation (always)
1. Read this ledger (§4 for your component).
2. Read the component SPEC in full (`engine/docs/frontend/agent_flow/components/cXX-*/SPEC.md`).
3. Read `components/README.md` (exit gate + global contracts + corrections log).
4. Create/refresh a todo list with the steps below. Exactly one `in_progress` at a time.

### Step 1. VERIFY firsthand (no verification, no design)
- Re-verify every SPEC "Engine binds" claim against current code with `file:line`
  citations. Code moved since 2026-09-17 is expected — log drifts in the SPEC's
  corrections area and in the new `PLAN.md` §Corrections. **A design that
  contradicts verified binds is wrong; fix the design, never the binds.**
- Resolve the component's Open questions IN THIS STEP (C06 leading-letter rule,
  C08 `user` scope, C09 costs-route fields — pre-answered in §4, confirm against
  the running engine — C11 update/provisioning/description
  questions). No scope control, banner action, or cost line ships on an
  unanswered question — the SPEC names which ones block.
- Audit the existing dedicated surface (§4 verdicts): read it, list what it already
  honors, list its gaps. KEEP + EXTEND is the default; rebuild only with written
  justification the user approves.

### Step 2. RESEARCH (mandatory, web-backed)
- Run 2–4 web searches on the §4 research directives for the component
  (enterprise-grade sources: vendor engineering blogs, 2026 RAG/agent-UX research,
  platform docs — never listicles, never undated claims).
- Synthesize into the `PLAN.md` §Research: numbered findings, each mapped to a
  concrete design decision. Research that changes no decision is omitted.
- Research NEVER overrides engine binds. When literature and the engine disagree,
  the engine wins and the tension is logged (see C05: no-retry, no-delete).

### Step 2.5. DESIGN ARTIFACTS for user review (mandatory, before code)
- Write dark-theme SVG design doc(s) in the component dir (C05 precedent:
  `design_<x>_sidebar_dark.svg` for the builder surface + `design_<x>_section_dark.svg`
  for the dedicated surface), in the locked visual contract (§5). Present them for
  user review; build NOTHING until the design is approved. Design review catches
  invented states (C05's old light mock promised DOCX + Retry — both unbuildable)
  before they become code.
- **Escalation rule:** if Step 1 proves the SPEC itself wrong (not the design —
  e.g. a cited file/route that does not exist, like C11's `registry.json`), STOP.
  Log it in PLAN corrections, propose the corrected binds, and ask the user before
  designing around the correction. Never silently re-scope a SPEC.

### Step 3. PLAN.md (FINAL before code)
Write `<component-dir>/PLAN.md` with ALL of these sections (C05 PLAN v2 is the format reference):
1. Verified engine truth (every claim with `file:line`).
2. Research synthesis (finding → decision).
3. Builder placement (slot kind or spine; shortcut — check collisions first: `K` is taken studio-wide; `⇧K` is knowledge).
4. Pure model first (bounds, labels, copy constants).
5. Hooks (extend existing; name the exact functions).
6. Projector + page deltas (grading truth table).
7. Variants & gates (empty/loading/error/denied/conflict + role matrix).
8. Corrections log (SPEC deltas found in Step 1).
9. Dedicated surface plan (keep-vs-extend verdict, gap list, non-goals).
10. Explicit non-goals (enterprise honesty — name what will NOT be built and why).
11. Query-key + invalidation plan (which `['studio', …]` caches are read, warmed, and invalidated on each write — shared caches like health/catalog must stay single-source).
12. Shortcut impact (new/changed keys vs the registry in §5; lock-test update if touched).

### Step 4. BUILD — two surfaces, one truth
Build in this order (each step complete before the next):
1. **Pure model** (`builder/lib/<x>-model.ts` + `.test.ts`, ranges green first).
2. **Hooks** — extend, never duplicate. New parsers tolerate old engines (absent → null, never a guess).
3. **Projector + `AgentBuilder` deltas** — usability grading (ready/attention/info/error + neutral-while-loading); bottom-action rule ONLY if the SPEC's publish gating demands a hint (hints, never invented blocks).
4. **Builder right-side section** (`builder/inspector/<X>Section.tsx` + styles + tests): the quick path — pin/attach/toggle/configure with the proven save machine (debounce 8000ms, full-payload PUT/POST, 409-adopt, 412 merge-or-reload dialog, dirty flag, Escape-blur, viewer read-only with role explanation).
5. **Wiring** — `BuilderInspector` case (+ `onDirtyChange` prop), `AgentBuilder` dirty/Escape/bottom-bar, palette copy, keyboard shortcut (collision-checked; the FIRST component that adds or moves a shortcut also adds the shortcut-map lock test in `slot-model` — no such test exists yet, so the map is convention-only until then).
6. **Dedicated surface** (§4 verdict per component) — the manage path: full inventory, full CRUD the engine actually exposes, filters, states, audit links. **If the engine exposes no verb (delete/retry/re-pin), the UI states it plainly and offers the real alternative. Dead buttons and faked joins are forbidden.**

### Step 5. TESTS AT THE END (per component, once, complete)
- Write all test files during Step 4, but RUN the gates once per component at the end:
  1. `npx vitest run` — FULL suite green (no new failures; pre-existing flakes named, never hidden).
  2. `npx eslint` on every touched file — clean.
  3. `npx tsc -b` — no new errors (pre-existing `ResearchPapers.tsx` error is documented, untouched).
  4. `npx vite build` — green.
- Triple-check pass before sign-off: (a) every label/limit/state traces to binds or a locked decision; (b) every engine read/write names route + role + payload keys; (c) empty/error/denied/conflict variants all render (no silent disables, no dead buttons, no generic toasts for typed errors).
- Test conventions (learned C01–C05, mandatory): components rendering `Link` mount inside a `RouterProvider` memory-router shell (two passes learned this the hard way); hooks mocked per-module with `importOriginal` spread; fake timers restored in `afterEach`; query-variant assertions use the SAME parser the component uses (never a parallel derivation).
- Suite hygiene (release-gate law): no skipped tests without a named reason on the record; no quarantined coverage; retries that hide failures are defects, not green.

### Step 6. SPEC flip
- Check off the SPEC Design boxes that shipped, append unbuilt-box notes if any, flip status to `SIGNED OFF` with date. Update this ledger's §1 row AND the `components/README.md` order/status table row (a SPEC flip that leaves the index stale is incomplete).

---

## 4. Component phases — remaining work, fully specified

### C06. Tools — catalog attach, approvals, drift, perimeter
- **SPEC:** `components/c06-tools/SPEC.md`. **Depends:** C01.
- **Engine binds (re-verify):** entries max **32** (contract wins over engine 50); name 2–64 `^[a-z0-9_]+$` (**leading-letter rule UNVERIFIED — resolve in Step 1, never enforce `^[a-z]` until proven**); access read|write; approval required|optional (default optional); schema_hash 64hex optional; execution_mode live|shadow (default live); perimeter first-class per row (environment in_process|sandboxed_microvm|external_gateway, egress 1–32 hostnames covering the binding host, in_process declares NO egress); shadow = simulated, executes nothing; verified controller roles (`tool-catalog.controller.ts`): catalog/templates/detail GET all-roles, upsert/from-template owner/admin/developer, `PATCH :name/enabled` owner/admin; approval vocabulary central and closed: `TOOL_APPROVAL_REQUIREMENTS = ['NONE','REQUIRED']` (`tool-catalog.schema.ts:74`) — consumer never→optional/none, on_effect|always→required, mapped ONCE (never per view).
- **Surface 1 (builder right):** tools satellite inspector section — catalog drawer rows (name, effect class, approval, enabled, credential-never-shown, schema-pin state, environment, egress, shadow badge); drift → review-change → re-pin flow (re-pin here is REAL — schema drift rejects publish, unlike knowledge); approval-required → request/approve inline; remove = unpin-only microcopy.
- **Surface 2 (dedicated):** KEEP + EXTEND `/agent-studio/tools` (`AgentStudioToolsPage`, `sections/.../tools/ToolsView.tsx`, 381 lines, substantial — shell + catalog table + Upsert/FromTemplate modals kept). Audited gaps to close: catalog filters/sort (effect/approval/enabled) — raw `rows.map` today; row drawer (edit pre-fill, history, re-pin — `CopyPinButton` copies the hash but no re-pin action exists yet); per-row pending (today one toggle freezes ALL switches); `rateLimit` free-number silent clamp → named validation; clipboard-failure path beyond toast.
- **Research:** MCP-catalog approval UX; schema-drift re-pin flows; sandbox/egress perimeter communication (enterprise); simulated-vs-live badging. Approval-queue card laws (researched 2026-09-17, apply to C06 inline approve + C15 queue): card carries the REAL payload diff (no label-only approvals); one-tap approve/reject (never per-action modal confirms — they train tap-through); reject REQUIRES a note (verify decision-endpoint support in Step 1, don't assume); approve executes inline with success/failure shown (click = commit point, no background race); gate by REVERSIBILITY (irreversible/external waits, read-only passes); reviewer fatigue is a slow leak — queue load is tuned continuously, not once.
- **Watch-outs:** effect class lives on the CATALOG row, never the entry; "Pin" covers tool hash-pins AND knowledge slug-pins — qualify everywhere (README #20); shadow NEVER gates anything (that law is C10's, respect it here).

### C07. Guardrails — policies, execution mode
- **SPEC:** `components/c07-guardrails/SPEC.md`. **Depends:** C01. Binds complete, no open questions.
- **Engine binds (re-verify):** `guardrail_policy` (input default `'default'`, output default `'brand-safe'`, pii_redaction default true); **execution_mode blocking|logging, default blocking** — the flip is a definition change (new draft, auditable), never a silent toggle; mode handed to Studio in context, enforcement Studio-side, engine versions contract + emits policy span; control blocks are a SEPARATE system (owner/admin, reason 1–512 mandatory, no warn mode).
- **Surface 1 (builder right):** guardrails satellite section — Simple view (input/output protection, PII, brand safety, denied patterns, safe defaults stated) + Advanced view (mode control, logging-vs-blocking indicator, custom patterns, thresholds).
- **Surface 2 (dedicated):** SPLIT — (a) KEEP + EXTEND `/agent-studio/blocks` (`libraries/blocks/BlocksView.tsx`, 217 lines — the canonical govern pattern: full-page govern gate kept). Audited gaps: target/status filters + search (5 `BLOCK_TARGETS`, none filterable); read-only guard for staff template rows (every row renders `Clear` today → 403-then-toast); expiry picker with futurity validation (ISO free-text today); `Expires-in-N` status (binary Active/Expired loses it); confirm for permanent (no-expiry) blocks; createdBy/At columns. (b) NEW read-only detail panel on the agent page (precedent: `BrainPanel`) for the per-agent policy (it has no library page and must not get one — policy is per-version truth).
- **Research:** measure-then-flip rollout UX (logging→blocking); moderation-transparency copy; PII-redaction control UX.
- **Watch-outs:** trace/operate surfaces must NEVER imply engine-side blocking for logging-mode verdicts (this lie ships in C07 if the copy is careless — the SPEC calls it out explicitly).

### C08. Memory — scope, history, summarization; org read-only
- **SPEC:** `components/c08-memory/SPEC.md`. **Depends:** C01. **BLOCKED until its open question resolves in Step 1.**
- **Engine binds (re-verify):** per-agent `memory_scope` (**`user` scope UNRESOLVED — engine default AND valid enum is `user`, older docs say omit; check console mapping + Studio contract, record the exact 3-or-4 options with plain-words consequences; NO scope control ships until answered**); history 1–100 default 30; summary default true; org-level scrub (off|redact|block) + TTL (3600–315360000) are READ-ONLY in builder, route to Admin › Settings; row shape uses `visibility` (default `organization`), temporal columns, soft-delete; proposals = approve/reject queue via Approvals destination (aggregate ONLY if proven non-empty); conversation-scoped items live on the conversation/trace or nowhere in v1 (stated).
- **Surface 1 (builder right):** memory satellite section — scope control with consequences, history stepper, summary toggle, org-default scrub/TTL read-only rows + settings route + purge entry (purge/TTL/ACL route to library, `governance`).
- **Surface 2 (dedicated):** KEEP + EXTEND `/agent-studio/memory` (`libraries/memory/MemoryView.tsx`, 138 lines, thin scoped browser — kept). Audited gaps: search + content detail drawer (full `content` renders raw, `scopeId` never shown so user/assistant rows blur); relative dates (raw strings today); proposals inbox (`useDecideMemoryProposal` exists, unwired — C11's eval flow needs it); per-row pending (one delete freezes all rows). **Includes the migration logged in C05 PLAN §10.5: move the memories block OUT of `KnowledgeView` into the Memory view.**
- **Research:** memory-scope consent UX; DSR forget-me/purge flows; temporal-version display; visibility-vs-ACL communication.
- **Watch-outs:** builder shows in-scope items READ-ONLY; nothing auto-accepts proposals; soft-delete always carries copy.

### C09. Budget — caps, cost preview, cache split
- **SPEC:** `components/c09-budget/SPEC.md`. **Depends:** C01. **Open question PRE-ANSWERED by this ledger's audit (confirm in Step 1, don't re-discover):** costs read = `GET /console/org/:orgId/models/costs` → `{costs: [{costMicrosPer1kInput, costMicrosPer1kOutput, currency, effectiveFrom, …}]}` (parser in `useSetupModels.ts` tolerates camel+snake). Step 1 confirms the fields against the running engine; the PLAN cites exact response keys.
- **Engine binds (re-verify):** `budget_policy` all-optional (tokens 1000–2,000,000; cost micros 0–1e12; wall clock 0–86,400; tool calls 0–1000; **model calls 1–200, min 1 — no "disable model calls" control may exist**); absent = manifest defaults (stated as platform defaults, never as zero); unpriced labeled, never zero-implied; cache-split renders the REPORTED split only (no lone-half derivation — engine-side); wall-clock breach fails closed (traces to C13's wall-clock-stop line).
- **Surface 1 (builder right):** NEW satellite kind recommended (`budget` — `slot-model.ts` is closed vocab; PLAN decides, shortcut collision-checked, and the   shortcut-map lock test gets written with it per the protocol's Wiring item) — plain-words caps (spend, tokens, tool/model calls, wall clock) with engine ranges as field bounds + estimate line vs unavailable label. (Only existing budget UI is one `AgentEditor` wall-clock field — extend-or-replace decision in PLAN.)
- **Surface 2 (dedicated):** KEEP platform billing/usage pages for spend truth; NEW read-only detail panel (precedent: `BrainPanel`) for the per-agent policy + estimate. No per-agent library page (policy is per-version truth, like guardrails).
- **Research:** AI cost-cap UX; breach communication (fail-closed copy); cache-cost split display; "unset vs zero" communication.
- **Watch-outs:** prompt/params-only edits always publish (manifest excludes prompt) — budget-only edits MUST publish (C14 depends on this truth).

### C13. Test run — streaming try console, trace (built BEFORE C10)
- **SPEC:** `components/c13-try/SPEC.md`. **Depends:** C01, C02, C04. Binds complete, no open questions. **Build before C10** (evals run against try-able drafts).
- **Engine binds (re-verify):** `POST .../versions/:versionId/test-runs`, `run_kind='test'` (no quota, no billing, never user-visible); prompt 1–8192 required; prerequisites = draft exists + ≥1 usable model (instructions advisory-only for test); SSE accepted→runId→stream + silence hint; **cost-stop vs wall-clock-stop as SEPARATE lines** (FAILED + terminal event + quota release); provider error + retry; run-plane-quiet check-status line; draft always intact; trace drawer = chunks (title/excerpt/score/version/pin state) + directive + tool calls (incl. simulated-for-shadow) + guardrail verdicts (**logging verdicts must not read as blocks**) + model/tokens/cost + cache split where reported; **causality highlighting BARRED** ("what it saw — not proof of why"); reload: draft restores from server, thread ONLY if engine persisted it (say so).
- **Surface 1 (builder right + canvas):** response slot console — thread (bubbles, streaming skeleton, citation affordance, input dock), prerequisite blocks with per-reason fixes, trace drawer sections + Edit jumps + re-ask loop. (Nothing exists in builder today — fresh build, C05/C04 fix-path patterns reused.) Transport MUST reuse `console/neryva-website/src/lib/engine/sse.ts` (`createSseParser`: fetch-based SSE with reconnect/backoff, `Last-Event-ID` replay, token-refresh-on-401, visibility-pause) — no new SSE client. The trace drawer is built as a SHARED common-UI `Drawer` (none exists — Modal/ConfirmDialog/Panel only); C10 and C15 reuse it, never fork it.
- **Surface 2 (dedicated):** KEEP + EXTEND detail `TestRunPanel` (exists) — share the trace drawer component, do not fork it.
- **Research:** AI chat-console UX; streaming skeletons/silence states; trace/citation display; SSE reconnect patterns; "advisory vs blocking" prerequisite copy.
- **Watch-outs:** test never bills and never shows to users — say it on the console; instructions-empty is advisory here but REFUSES at publish (name both, confuse neither).

### C10. Evaluation — datasets, runs, decisions, shadow, drift
- **SPEC:** `components/c10-evaluation/SPEC.md`. **Depends:** C01, C13. Binds complete, no open questions.
- **Engine binds (re-verify):** `POST .../versions/:v/evaluate` → `eval_run_id`; decision BLOCK (>any block) / WARN (>warnings) / PASS; **BLOCK refuses publish AND rollout promotion; later PASS on same hash clears (latest wins); WARN blocks only template-declared required checks; with declared `required[]`, ONLY fresh PASS on THIS hash publishes**; refusals are **409 verbatim** (never render as form errors — README #3); **shadow NEVER gates** (badge "shadow — never gates", 24h dedup); **`no_dataset` drift alerts WITHOUT an eval**; **STALE decision is the highest-confusion state — design first** (`PASS on a41f… · draft now b77c… → Stale decision` + re-run); drift watch/alert (amber) vs shadow (info/blue); datasets org-level at Libraries → Datasets; no-dataset evaluate = 422 WITH the fix (picker/deep-link must exist); drafts evaluable (synthesized snapshot); failing cases = input/expected/actual/rubric → edit → re-run loop.
- **Surface 1 (builder right):** evaluation satellite section — seeded-vs-attach dataset view (honest no-fake copy), run + results (PASS/WARN/BLOCK, required-vs-optional, failing-case anatomy, re-run), shadow badge + drift alert, stale-decision banner FIRST.
- **Surface 2 (dedicated):** KEEP + EXTEND `/agent-studio/evaluations` + `/agent-studio/datasets` (`evaluations/EvaluationsView.tsx`, 485 lines — runs/datasets/recall ledger kept). Audited gaps C10 MUST close: DRAFT evaluate path (`StartRunModal` is PUBLISHED-only today with no draft link — yet drafts ARE evaluable); case browser (add-only today, no list/edit); dataset/decision/state filters + pagination (cap-100, single expanding row collapses on refetch); wire promote/reject (`usePromoteCandidate/useRejectCandidate` exist, unwired); provenance copy buttons (values truncate at 64/200 chars); attempts clamp + empty-dropdown states in the modal.
- **Research:** eval-verdict UX (PASS/WARN/BLOCK); golden-dataset management; stale-result communication (the confusion research); shadow/canary badging. Gate-not-dashboard laws (researched 2026-09-17): KPI row (pass rate, regressions, pending reviews) above the fold; release-gates table with status/pass/regressions/model/version; scorecard baseline-vs-candidate per metric; regression table WITH severity (critical/high/medium/low by delta); trace detail = input + context + expected + BOTH outputs + cost/latency; human review queue prioritized by severity with approve/needs-fix/ignore + notes; immutable audit log with before/after + note; stale-baseline warnings named, never silent.
- **Watch-outs:** gate refusals 409 not 422; `required[]` items may be OBJECTS (e.g. `{regression_no_worse_than: 0.02}`) — render both shapes, never the engine's `join(', ')` verbatim (C11 depends on this too).

### C11. Templates — gallery, detail, install, updates
- **SPEC:** `components/c11-templates/SPEC.md` (MODEL RESOLVED). **Depends:** C01–C10. **Three open questions MUST be answered in Step 1** (update-adoption mechanism, description editability, provisioning transport) — banner/action design depends on them.
- **Engine binds (re-verify):** registry = DB table `assistantTemplates` (global platform-plane, `templates.service.ts`), fed by the CI release job `engine/src/scripts/sync-template-registry.impl.ts` — there is NO `registry.json` for the console to read (the SPEC's `products/agent-studio/templates/registry.json` path is STALE; Step 1 corrects the SPEC). Console binds to the LIST endpoint reads (`useAssistantTemplates` → `GET .../assistant-templates`); counts/families/statuses verified against the RUNNING engine in Step 1, never hardcoded, never assumed "20". Governing model **Template = contract. Pins = fulfillment. Eval = proof** (portable-only contents; anything org-specific is per-org fulfillment; any design asking users to retype contract content is wrong); install TX (422 pre-row on unknown/disabled tools, 409 platform block, name default = slug 2–128 + 409 collision, DRAFT v0 verbatim + install row + outbox, **active pointer untouched**); compat advisory-only 4 codes; list rows `installed` + `update_available` (none|minor|major); seeded dataset `template:<slug>@<version>`; snapshot `templateRef`; channels bindings read-only until channels ship; template NEVER contains credentials/version-pins/approvals/promises; full I1–I8 outcome matrix + repair-checklist matrix in SPEC (every row needs a designed state).
- **Surface 1 (builder):** origin-mode gallery INSIDE the builder (locked decision; exact mount — new-mode start screen vs dedicated origin step — decided in PLAN with options, not assumed) + install stepper (I7 provisioning states, I2–I6 whispers, I1 success → prefilled map + badge + repair checklist) + I8 failure banner + update banners (wording per Q1 answer). Not a right-inspector section — a builder origin surface.
- **Surface 2 (dedicated):** KEEP + EXTEND `/agent-studio/templates` (`AgentStudioTemplatesPage`, `sections/.../templates/TemplatesView.tsx`, 807 lines — the richest of all six audited surfaces: FilterBar, TemplateCard grid, 6-tab DetailModal, InstallWizard, PostInstallChecklist). Audited CORRECTNESS bugs C11 MUST fix (not features — wrongness): credentials row hardcodes a green pass (vacuous); `toolGaps` checks only `enabled`, ignoring hash/version drift; `docsBySlug` last-write-wins on duplicate slugs; checklist sub-queries render loading as gaps. EXTRACT `PostInstallChecklist` as a shared component (C06/C10 rows plug into it). Extend: search beyond slug+family, eval-case untruncation, live Channels state, Test-run deep-links. Template-targeted platform blocks render ON the card; re-install legitimate (confirm names the duplication, never silent).
- **Research:** template-gallery UX; install-wizard/provisioning-progress UX; update-adoption flows; compatibility-badge communication.
- **Watch-outs:** install can NEVER go live; never auto-migrate on update; `installed` re-click creates ANOTHER assistant (say so); required[] objects (shared with C10).

### C12. Origins — clone, import
- **SPEC:** `components/c12-origins/SPEC.md`. **Depends:** C01, C02. Binds complete, no open questions.
- **Engine binds (re-verify):** clone = full-definition copy as NEW assistant, DRAFT, original untouched (warn-once line), same name rule + 409; import = `POST .../versions/import` → DRAFT (deterministic envelope, `schema_version` number-validated, hash+schema stripped pre-compare); **client validates FIRST** (shape + contract caps, exact dotted-path errors — nothing invalid is sent); import MUST land highlighted on the draft, never silently on detail.
- **Surface 1 (builder-adjacent):** start-screen overlays — clone picker (search, status pill, copy-semantics warning) + import pane (paste + file drop, client-first errors, schema_version display, identity-name resolution). Exact host (agents overview vs builder new-mode) decided in PLAN with options, not assumed.
- **Surface 2 (dedicated):** UNIFY existing clone (`PurposeInspector` "Clone agent") + import (`AgentDetailView` import flow, `useImportVersion`) into the overlay system. No new route.
- **Research:** clone/duplicate UX; JSON-import validation UX (client-first error display); envelope/version display.
- **Watch-outs:** unknown payload keys → 422 dotted paths (client must produce the same shape discipline); no-op import states (same content → say so, C14's no-op law is the cousin).

### C14. Publish — readiness, success (depends on ALL)
- **SPEC:** `components/c14-ship/SPEC.md`. **Depends:** ALL of C01–C13. Roles: publish/rollback = owner/admin ONLY; developers get explained row + request path, never silent disable.
- **Engine binds (re-verify):** required set rendered from the required-checks READ, never hardcoded (instructions; ≥1 usable model; pins resolved-or-acked; tool pins fresh; approvals satisfied; fresh-PASS-where-declared; no blocking blocks; no drift); gate refusals 409 verbatim; **publish click with open issues scrolls to first — never dead click**; degraded ack in body + rollback, audited; idempotent + advisory-locked + atomic swing, snapshot/provenance in-TX, in-flight runs stay pinned; 412 stale → merge-or-reload, draft intact; **no-op = joint content+manifest 409 → pre-empt with `No changes to publish`** (prompt/params-only always publish; same-content + drifted-manifest = legitimate re-publish); success = version + hash + template badge + eval decision on hash + degraded statement; next = channel (inline-create-or-pick with `returnTo`, never dead "Binding required"), watch, build another, back to agents.
- **Surface 1 (builder):** ship slot — readiness card (required vs optional-skipped, per-row fix/jump, anchored popover) + publish rail (hash, schema, snapshot note, rollout note, what-happens) + degraded-ack copy + success screen (3 exits + provenance footer).
- **Surface 2 (dedicated):** KEEP + EXTEND detail `PublishPanel` (exists) — same readiness source, do not fork the required-checks read.
- **Research:** release-readiness checklists; publish ceremonies/success screens; rollback UX; audit-receipt display; dead-click prevention patterns. Readiness laws (researched 2026-09-17): blocker-vs-advisory taxonomy written BEFORE release day (blast radius × severity × reversibility — cosmetic-with-workaround never blocks); readiness as Go / Conditional-Go-with-named-exceptions / No-Go (never a bare percentage); every blocker carries a reproduction (steps + build + state), so triage decides instead of investigates; ONE accountable decision-maker records go/no-go with date + build; rollback is practiced (exercised path or kill switch), never hoped.
- **Watch-outs:** the degraded ack checkbox lives HERE (C05/C10/C06 rows link to it; none implement it); failure reverses ceremony with the exact issue in a whisper.

### C15. Operate — versions, lineage, rollouts, health, audit (LAST)
- **SPEC:** `components/c15-operate/SPEC.md`. **Depends:** C14. Last component.
- **Engine binds (re-verify):** versions + `parent_version_id` lineage (read-only provenance); rollouts weighted + pause/resume, paused banner verbatim (`paused_reason/by/at`; burn-rate service-only — surface state + audit, never a burn endpoint); degraded lifecycle (`degraded_until` + reason ≤512, T-24h warn-once, past-due auto-suspend); banners read C05 health + C10 drift/shadow + C04 compromise (reuse those hooks, never re-derive); rollback (owner/admin, ack accepted) restores exact prior; retire read-onlys; disable/enable + delete lifecycle-gated (delete 409 until conversations archived); **Day-1 emergency = exactly two toggles** (pause rollout + disable/kill) with confirms — analytics/anomaly/sliders DEFERRED (locked); Observe rollups + eval history + traces + channels + audit.
- **Surface 1 (builder):** re-entry only (new draft → same shell, resume-at-first-incomplete). NO new inspector section.
- **Surface 2 (dedicated):** KEEP + EXTEND the detail operate cluster (`OperatePanel`, `ObservePanel`, `AgentTrail`, audit) — operate layout (active version, draft status, lineage view, rollouts, evals, cost, blocks, incidents, channels, audit) + emergency toggles + banners with fix paths + async-provisioning state carried permanently on detail (dead-letter after tab close).
- **Approvals destination decision (SPEC-mandated):** aggregate runtime approvals + memory proposals + escalations ONLY if EVERY filter option is provably non-empty; otherwise separate destinations, one visual pattern. Existing `/agent-studio/approvals` (`approvals/ApprovalsView.tsx`, 336 lines, two-tier gating kept) audited gaps feed the decision: NO payload drawer (Summary+ref only — violates the payload-diff card law); queue-wide pending lock (one decision freezes all rows); no live refresh for a pending queue; `EXPIRED` filter correctness unverified (expiry is read-computed); run refs truncated with no trace link; decision actor + reason never shown; `DecideModal` null-renders on missing runId. The C06 card laws apply here verbatim.
- **Research:** incident-banner UX; kill-switch/pause UX; lineage/provenance views; rollout monitoring (paused-state communication).
- **Watch-outs:** "rolled back" is NOT a version status (DRAFT…PUBLISHED…RETIRED; rollback births new); every org-scope confirm promises "Recorded in Audit" ONLY with a pre-filtered Audit link (README gate).

---

## 5. Design language — Apple iOS-inspired, zero compromise

This is the locked visual contract (established C01–C05, reference: `components/c04-brain/design_brain_detail_dark.svg`, `components/c05-knowledge/design_knowledge_*.svg`):

- **Platform feel:** iOS-dark idiom — near-black app bg, elevated cards, 8–16px radii, 1px hairline borders, SF font stack (`-apple-system, 'SF Pro Text', Inter, system-ui`), semibold titles / regular body / muted captions, restrained single-accent color per surface (surface accent = slot color on canvas only).
- **Tokens only:** every color/spacing/type value comes from `theme.app.*` — verified families: `status.{success,warning,error,info}.{fg,bg,border}`, `surface.{subtle,active,tint}`, `bg.base`, `border.{default,strong,hover,focus}`, `text.{primary,secondary,muted,ghost}`, `type.{body,caption}`, `typography.fonts.mono`. **No hardcoded hex in product code** (SVG design docs excepted). A token that doesn't exist is not invented — the PLAN names the gap.
- **Status language:** dot + word, never color alone (`StatusDot`/`StatusPill`); tones map to engine states 1:1 (no invented states, no merged machines).
- **Copy voice:** plain words, stated consequences, named fix paths; deliberate-states stated ("Retrieval off — deliberate, not empty"); destructive truths stated ("No retry exists", "Documents can't be deleted from this UI"); whispers for consequences, alerts for blocks; audit promises only with links.
- **Structure:** one purpose per surface (research-backed); builder = quick path (satellite/spine sections, dirty-guarded, Esc-safe, keyboard-mapped); dedicated page = manage path (inventory, filters, full states, deep-links both ways). Detail panels are READ-ONLY with `Edit in builder →` links — they never fork editable state.
- **Motion:** token-sheet motion only (`design/_system/design_tokens.svg` per README); stagger indices sequential and unique; skeletons for streaming/loading, never blank panels.
- **Icons:** lucide, 13–14px, stroke 1.7–1.8, decorative icons `aria-hidden`.
- **Accessibility baseline (non-negotiable for enterprise):** keyboard-reachable + visible focus on every control; real labels on every input (placeholder is not a label); contrast by token (never color-alone — see status language); modals/drawers trap + return focus, `Esc` closes; touch targets ≥24px; no new animation libraries (follow existing motion patterns).
- **Language:** English-only. No i18n infra exists in the app (verified 2026-09-17) — strings ship inline; do not invent key systems.
- **Telemetry:** none exists in product code (verified 2026-09-17 — no `builderTelemetry` or analytics calls). Do NOT add tracking without a PLAN decision AND explicit user approval.
- **Performance budget:** heavy surfaces lazy-load (xyflow precedent — builder canvas chunks separately); no new dependency without PLAN justification + bundle-impact check; lists over ~30 rows get filter/pagination (audited enterprise gap in four of six views); no N+1 query patterns (fleet-health shared-cache precedent).
- **Builder shortcut registry (verified 2026-09-17, `AgentBuilder.tsx` keymap — check collisions here first):** `Esc` deselect/close · `N` palette search · kind keys `T/G/B/E` (+`⇧K` knowledge, `⇧M` memory) summon-or-focus · `M` skip selected · `Delete/Backspace` detach · studio-wide `K` navigates to the Knowledge library (NEVER steal it in builder). Never fires from inputs (except `Esc`, which blurs first when dirty).

---

## 6. Non-negotiable laws (violation = the work is wrong)

1. **Verify firsthand.** Every bind cited `file:line`. "Already verified" never overrides a fresh read.
2. **Research, then PLAN, then code.** No code before `PLAN.md` is FINAL.
3. **Two surfaces per component** (§4): builder quick path + dedicated manage path. A component with one surface is incomplete.
4. **Tests at the end, per component** (§3 Step 5): full suite + eslint + tsc + build, once, complete. Never "tests later".
5. **One component at a time, in §2 order.** No parallel component builds.
6. **Extend, never duplicate** (hooks, drawers, reads). A second derivation of the same truth is a defect.
7. **Honesty over completeness.** No invented endpoints, states, counts, or joins. Missing engine capability = stated copy + real alternative, logged in PLAN non-goals.
8. **Roles are rendered, never silent.** Every gated control names the required role + request path. Server enforces; UI explains.
9. **OCC + idempotency on every write.** Draft edits carry `If-Match`; 412 → merge-or-reload dialog; writes carry `Idempotency-Key: uuidv7`; 409 adopted with copy, never raw errors.
10. **Codename policy** (README): retired words (Blueprint, Mirror, Brain, Hands, Purpose-as-label, Try/Ship-as-nouns, Spark, Artifact, Studio-in-copy, Engine Room, Fleet-in-nav) live ONLY in internal identifiers. Zero user-readable occurrences. (Pre-existing violations are fixed when touched, never copied.)
11. **Additive routes/nav only.** No moves, no renames, no silent reordering.
12. **SPEC flips only on evidence.** SIGNED OFF + date, with the gates' actual numbers recorded in the final message.
13. **Audit promises need audit links.** Every "Recorded in Audit" confirmation links the pre-filtered Audit view (README gate) — a promise without a link is removed, not shipped.

---

## 7. Corrections log (append; never rewrite history)

- 2026-09-17 (C05): SPEC claimed document retry/delete = org-scoped — **no such endpoints exist**; no retry/delete controls built (re-opens if engine adds routes). Slug rename is owner/admin/developer, not governance-scoped. Connector `returnTo` not built (engine OAuth callback lands opaque) — links out with stated copy. Bare `K` collides with studio-wide Knowledge navigation — builder satellite is `⇧K`.
- 2026-09-18 (C10): SPEC "422 with the fix" → engine emits **400**; promotion gate is separate/inline per version row with NO shadow exclusion (publish copy never claims shadow-safety for promotion); gate keys the CONTENT hash (manifest separate); results carry `response_excerpt`, not `actual`; mixed `required[]` objects bind as the regression bound (gate filters non-strings, then joins — UI never joins mixed arrays); `environment` accepted but provenance-null; the "PUBLISHED-only" docblock is stale (drafts evaluate); no case-LIST endpoint (anatomy = ids+reasons+excerpts; loop is add-case → re-run); promote/reject unwired (no candidate-list endpoint — no dead buttons); provenance carries NO version content hash, so staleness is the timestamp rule (DRAFT updatedAt vs run finishedAt; PUBLISHED immutable) and the banner shows times, not the SPEC's hash pair.
- 2026-09-18 (C11): SPEC `registry.json` is build input, not the console read path (DB-backed list; "20" is a snapshot — counts bind to reads); live rows serialize camelCase (`evalRef/releasePolicy/minEngineSchema` — snake-only parser nulled them, fixed); install failures are 400/403/409, never 422 (platform 403 precedes validation; org 409 in-TX after pins); SPEC I7 phase machine doesn't exist (one TX + 3-step consumer — no stepper, live checklist, draft editable at once); Q1 no update endpoint (re-install-as-new + diff, never in-place/migrate); Q2 no description route (immutable — wizard input removed); Q3 no provisioning progress read (no poll/SSE/status); installed entries carry no `assistantId` (badge routing unbuildable — stated, re-install confirm instead); 4 checklist correctness bugs fixed (always-green credentials → role-aware truth; hash never compared → pin compare when both exist; duplicate slugs last-wins → READY-first deterministic + count; loading-as-gaps → skeletons + error retry).
- 2026-09-18 (C12): no `POST .../clone` exists — clone is client composition (GETs + POST assistants; behavior binds hold via create); import creates a DRAFT child on the EXISTING assistant (never new — detail UI must unwrap `.export`, pasting raw files 400s); all validation failures 400, never 422; no-op import = success new DRAFT (or 409 `draft_exists`); idempotency keys fresh per call (panes disable while pending); `schema_version` number-checked only (warn-only display, never gate/block); unknown keys strip with stated warnings (engine zod-strips pre-hash); uncovered engine caps enumerated, not re-implemented (no second derivation); landing unified (all clones → build path + named toast; import → draft pulse + scroll + banner).
- 2026-09-18 (C14): no required-checks endpoint (provenance.lastEvaluation + template.releasePolicy.required + local checks, composed); no 412 on publish/rollback (OCC is PUT-draft-only — advisory lock + no-op 409 carry publish concurrency); success POST returns `{version}` only (badge/decision/statement composed from reads); no channels `returnTo` (console-greenfield — route validateSearch + preselect + post-create navigate, no engine change); provenance is a derived read (only the snapshot writes in-TX); approvals / control-blocks / drift-as-refusal are NOT publish gates (zero hits on the publish path — never rendered as rows); no rollback reason field (RollbackDto has no reason key; the rollback itself audits as `assistant.rolled_back`); `validation.ts:184` "Typed 422" comment is stale (code throws 400); degraded refusal is 400 `knowledge_pins`, gate refusals 409 with `assistant_id` details; DRAFT/VALID/VALIDATING all publishable (service.ts:708); module-mock lesson: `vi.mock` spread cannot rewire a function's internal sibling calls — pure derivations (`derivePublishReadiness`) unit-test directly, hooks stay thin composers.
- 2026-09-18 (C15): no resume route (resume = re-set/re-promote at same variants); manual pause reason is the literal `'operator'` (actor in `paused_by`); `'ROLLED_BACK'` is enum-historical, never written (rows never carry it); audit query is EXACT-match on action (the "prefix filter" comment is stale — `AgentTrail`'s `action:'assistant.'` matched nothing in production, fixed to newest-100 + client prefix set); no per-assistant trace/channel reads (org reads filtered client-side); memory proposals have no list read and escalations no console reads (aggregate unbuildable — separate destinations stand, approvals card pattern is the reference); no provisioning progress read (dead-letter UI unbuildable); staff template-block reads are staff-guarded (no read-only rows); decide endpoint stores `reason?` (deny-requires-reason is endpoint-supported) but the list returns no reason column (history = actor + time, reasons via audit); `?slot=` re-entry validated pure (`resolveInitialSlot` — spines always, kinds only when bound).
- 2026-09-18 (C13): SPEC controller cite `:215-227` → actual `:215-233`, lower-bound-only (service owns the upper bound); **no engine cost-stop** (token/cost caps enforce Studio-side — cost lines reported-only); "never user-visible" unenforced (no flag/filter — states only no-quota/no-bill/draft-intact); per-run excerpts/scores/version-pin not durably reported (trace renders arrivals only); every send is a fresh test-run POST (follow-ups/regenerate resolve via the published pointer and would silently leave the draft pin — never called from Try).
- (Future corrections append here with date + component.)

---

## 8. Ledger amendments (how this file changes)

This ledger is FINAL, not frozen. Amendments append here as dated entries (what
changed, why, evidence) — history is never rewritten. A correction that changes a
phase's verdict or order needs explicit user approval; typo/clarity fixes do not.
Amendments: (none yet — the C11 registry correction and this review's patches were
made pre-sign-off during this ledger's own review, 2026-09-17.)
