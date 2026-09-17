# Customer Journey Review — Company A Sets Up Three Agents (v1 audit, 2026-09-17)

> Status: IMPLEMENTED 2026-09-17 (all 13 gaps built; gates green; live-verified over HTTP — see §7).
> Original status: REVIEW. Written from the customer's chair, verified against the code — no sugar coating.
> Method: walked the journey as Company A (fresh account → dashboard → three agents: customer-service, financial, brand-representative), pausing at
> every step to ask "what would have been better, and which available option is finally best". Every engine claim re-read firsthand during this
> review; live HTTP verification from the v1 build session is cited where it exists. Items marked **[needs verification]** are explicitly NOT
> verified — they are questions, not findings. Anything unverified is labeled; nothing is invented.
> Scope: frontend + engine + MCP + agent-studio backend. Out of scope: billing math, tenancy/RLS, pricing policy.
> Companion docs: `agent-setup.md` (spec), `team_setup_ledger.md` (what v1 built).

---

## 0. Verdict up front (read this, then the evidence)

v1 is a **genuinely strong setup plane**: the engine contracts are real, the frontend honors them, and the live-verified funnel (install → map →
test → evaluate → publish → operate) works end to end with honest errors. Company A **can** build three working agents today.

But Company A **cannot finish the job**: after publishing, their agents are unreachable by customers (no channel/deploy surface in the console),
their financial agent's approvals have nowhere to be approved, their brand agent's "brand voice" never reaches the runtime, they set budgets blind
(no prices anywhere), and they must discover the entire funnel alone (no guided entry). The journey is: **excellent machinery, no last mile, no
guide**. Concretely: **2 critical journey-breakers, 4 high-severity gaps (one of them a launch-blocker question), 4 medium, 2 low** — plus 3
verified engine bugs found during live verification (2 fixed in-session, 1 reported below with the exact fix).

Rank by what the customer feels, not by what was hard to build:

| # | Gap | Customer pain | Severity | Owner |
|---|-----|---------------|----------|-------|
| G1 | No channel/deploy surface in console | Published agents unreachable (except internal chat + API) | **CRITICAL** | Console (engine complete) |
| G2 | No approvals queue anywhere | Approval-gated tools stall with no approver UX | **CRITICAL** | Console (engine has list+decide) |
| G3 | Empty platform model catalog for fresh orgs? | Maker picker empty → cannot create any version | **CRITICAL if true (launch-blocker — verify prod seeding)** | Ops/staff-plane + console guidance |
| G4 | Brand voice never reaches runtime | Brand agent can't be on-brand except via instructions | HIGH | Engine (wire into assembly) or console (remove field) |
| G5 | Export→import round-trip broken over HTTP | Version portability dead (400 on real envelopes) | HIGH | Engine (1-line DTO fix, specified below) |
| G6 | Zero cost visibility | Budgets set blind; burn-rate pauses unexplained in money terms | HIGH | Engine (console cost route) + console |
| G7 | No guided setup funnel | Company A must self-discover 9 surfaces in the right order | HIGH | Console only |
| G8 | Eval authoring hostile to non-technical makers | JSON cases, no case list, no candidate queue, undisclosed lexical scoring | MEDIUM | Console + 2 platform asks |
| G9 | Knowledge gaps (bulk, URL ingest, re-ingest, preview) | Librarian work is one-file-at-a-time; pasted URLs don't ingest | MEDIUM | Console (+1 verify) |
| G10 | Operate observability gaps (names, env vocabulary, audit trail) | Paused-by-UUID, free-text envs, no per-agent trail | MEDIUM | Console (+1 engine nice-to-have) |
| G11 | Fleet has no health picture | 3 agents' live/degraded/BLOCKed state not visible at a glance | MEDIUM | Console only |
| G12 | Editor polish (token counter, params guidance, cost estimate) | Makers guess at caps and params | LOW | Console only |
| G13 | Test-run transport (polling vs SSE) | 90s poll window; chat already streams | LOW | Console (reuse SSE) |

Fixed during live verification (v1 build session, already in): rollout `id` default migration (0062), search `?limit=` coercion, eval `addCases` 422s, retrieval `sourceRange` object coercion. Details in §10.

---

## 1. The journey, step by step (what Company A actually experiences)

### Step 0 — Signup → dashboard. "Where do I even start?"

**Current:** OAuth works, welcome onboarding is durable, dashboard greets with passive empty states ("No agents yet — create one from the Agents page").
**Pause and think:** Company A has a goal ("three agents"), not a map. Every best-in-class setup product (Intercom Fin, Copilot Studio) opens with a
goal-oriented checklist, not a dashboard of empty widgets. What would have been better: a **setup checklist** (org has assistants? documents?
usable models? published versions? serving channels?) computed from endpoints that already exist, plus a template-first entry ("start from a
support blueprint"). Nothing new engine-side is needed for v1 of this — it is pure console composition over live reads.
**Best selection:** G7 — build the guided funnel entry (console-only). It multiplies the value of everything else.

### Step 1 — "Give me a customer-service agent." Templates → install.

**Current (verified live):** gallery with 20 real blueprints, per-reason compatibility truth with fix links, BOM detail (definition/tools/knowledge/
channels/eval rubric/release policy), one-TX install into DRAFT v0 that never goes live, post-install checklist with live mapping/tool/model states.
This step is genuinely best-in-class already. The install-time pin refusal (verified live: `template tool pins unresolved`) is correct strictness with
a named fix.
**Pause and think:** what breaks? (a) A non-technical maker meets `required_tool_missing` and must register catalog tools — the checklist says what,
not how; a "register the two missing tools for me" guided path would beat documentation. (b) Install offers no preview of what the agent WILL say
(no sample turns from seed cases — the eval cases exist and could render as "try these after install"). (c) No duplicate-name pre-check feedback
until submit (server 409 is correct; client pre-check against the fleet list would be kinder).
**Best selection:** keep the step; add sample-turn preview from seed cases + fleet-aware name pre-check (console-only, small). The auto-tool-registration
idea is rejected on reflection: tools carry credentials and effect classes — silent registration would be the wrong kind of magic.

### Step 2 — "Teach it our policies." Knowledge: uploads, connectors, mapping.

**Current (verified live):** presigned upload → PUT → complete → READY in ~12s; inventory with states; kebab slug discipline with verbatim 409s;
derived slugs; connector linking for 7 providers with per-provider auth truth; Drive dance pointer; OAuth app registry; search console with byte-range
citations (after the F6 object-coercion fix).
**Pause and think:** Company A's librarian has 200 help-center pages, not one PDF. One-file-at-a-time upload with no bulk path and no folder/URL ingest
(the old mock's "paste a URL" was correctly killed — but the underlying desire is real; the sitemap connector needs an XML URL most marketers don't
know) will feel broken on day two. Re-ingest exists server-side (`target_document_id`) with no UI — policies change, and today the librarian's only
move is upload-a-new-doc + rename-slug surgery. No chunk preview means no way to check "did it ingest the table or mangle it?".
**Best selection:** G9 — bulk upload queue (already architected per-file; mostly UI), URL-to-sitemap helper ("paste your docs URL, we'll find the
sitemap.xml"), re-ingest-as-new-version action, chunk preview drawer. All console-side except nothing. Tombstone resurrection ("resync revives the
mapping") is claimed in UI copy from slug determinism — **[needs verification]** live before promising it to customers.

### Step 3 — "Pick the model." Catalog, BYOK, enablements, residency.

**Current:** live availability with inline disable-reasons; fingerprint-only BYOK with step-up create/rotate and proof-free revoke (refusal verified
live); enablement matrix; residency tags + honest refusal surfacing.
**Pause and think:** three problems, escalating. (a) **If the platform catalog is empty in prod, this entire product is bricked for every new customer**
— the picker is empty, versions require ≥1 model, nothing ships. Dev was empty. G3 is a launch-blocker question, not a finding: confirm staff seeding
is a launch op, and add an explicit empty-catalog state ("the platform catalog isn't published yet — contact support") instead of today's generic
empty message. (b) No prices anywhere (G6) — the financial agent's owner sets a 45M-micro budget with no idea what a run costs; burn-rate can then
auto-pause production with costs the customer never saw coming. (c) Residency is display-only with govern-plane editing elsewhere — acceptable only
if the govern path is discoverable; today it isn't linked.
**Best selection:** G3 (verify + empty-state), G6 (cost route + catalog cost fields), residency deep-link to the govern surface.

### Step 4 — "Make it ours." Authoring: instructions, tools, guardrails, budgets, brand.

**Current:** single mapping module (registry round-trip proven in tests), caps pre-check inline, catalog tool picker with effective approval + one-click
re-pin, If-Match concurrency with merge-or-reload, autosave, wire-JSON preview, secret scanner.
**Pause and think:** (a) **Brand voice is decorative** (G4 — verified zero runtime references). Company A's brand agent gets a field that does nothing.
This is the single most trust-damaging gap in the editor: a visible control with no effect. Either the engine assembles brand into the system prompt
(with provenance — my recommendation: it's the documented purpose of the field, server-enforced, auditable) or the console deletes the field and folds
the guidance into instructions. A decorative control must not ship. (b) Temperature/top_p/reasoning/output-schema have no guidance — makers will cargo-cult
values; one-line explanations + safe defaults per family would beat tooltips-to-nowhere. (c) No live token counter against the 20k cap (issues only fire
after exceeding). (d) No cost estimate ("this draft ≈ $X/run at list prices" — blocked on G6).
**Best selection:** G4 first (correctness of meaning), then counter + guidance (console-only).

### Step 5 — "Prove it works." Test-run → evaluate.

**Current (verified live):** draft-pinned test acceptance; draft evaluation with synthesized snapshots (R-2, the funnel's keystone); decision +
provenance display; required-checks/BLOCK gates speaking verbatim; recall@k with real shape.
**Pause and think:** (a) Test replies can't arrive here without LLM credentials AND the studio runtime (dev showed `studio startRun unavailable`
dead-letters with deployment off) — the panel handles absence honestly, good; but a maker can't distinguish "my agent is broken" from "the building
has no power". The panel should surface run-plane health (a cheap status read) when replies never come. (b) Formal eval is JSON-cases-or-nothing for
makers (G8): no case builder, no case list, no candidate queue, recall needs `document_ids` the UI never helps author, and interim lexical-only scoring
is undisclosed (the worker says so in provenance; the UI should say "lexical assertions now, LLM judges via Studio eval-worker" in plain words).
(c) Stale-eval hazard is real and handled (hash-keyed gates + "edited since" truth) — good; keep.
**Best selection:** G8 — case builder form, list-endpoint platform asks, scoring-scope honesty line, run-plane health hint in test panel.

### Step 6 — "Ship it." Publish gate.

**Current (verified live):** pre-flight mirroring server order, audited degraded bypass, advisory-locked atomic swing, no-op/BLOCK/required-checks/
pins all verbatim. Excellent.
**Pause and think:** almost nothing missing. Two refinements: (a) the acknowledge-degraded checkbox is powerful and dangerous in equal measure — require
typing the slug count or similar friction for production assistants? Deliberate choice: keep one-click for now (audit exists), revisit after first
customer incident. (b) No scheduled/embargoed publish (publish-when-eval-passes). Rejected on reflection: async publish is a worker + state machine the
engine deliberately doesn't have; manual publish after PASS is the honest flow.
**Best selection:** nothing structural. This step is done.

### Step 7 — "Run the business." Operate: rollout, releases, blocks, kill, observe.

**Current (verified live, incl. the migration fix):** weighted splits with sum-100 discipline, BLOCK-aware pickers, verbatim pause attribution, env×channel
pointers, mandatory-reason blocks, proof-free kill, degraded banners, rollups with honest nulls.
**Pause and think:** (a) Pause attribution renders actor UUIDs (`Paused by 6223…: operator`) — operators don't know UUIDs; map to member names (console has
the members list). (b) env/channel are free text with production/default conventions undiscoverable — suggest chips of known addresses (from existing
rollout rows) without inventing a registry. (c) No per-agent operate audit trail in view (org audit exists elsewhere; a filtered "what happened to THIS
agent" timeline would pay for itself during incidents). (d) Burn-rate pauses arrive with costs the customer can't contextualize (→G6).
**Best selection:** G10 — names, known-address chips, per-agent trail (console-only; trail is a filtered read of existing audit if the endpoint supports
it — **[needs verification]**).

### Step 8 — "Put it in front of customers." Channels. **THE CLIFF.**

**Current:** engine has the full plane (accounts, sealed creds, verify, webhook-setup with once-shown token, default_assistant binding with routability
checks, widget surface). Console has **nothing** — no channel list, no connect flow, no credential rotation UI, no verify-token reveal, no assistant
binding picker, no webhook-setup guidance, no widget embed snippet, no per-channel health.
**Pause and think:** this is where Company A's journey ends today: three published agents reachable via internal chat and API only, while every template
they installed advertises web-widget/whatsapp/messenger/telegram. The cruelest version of this gap: the customer did everything right and still can't
serve a single customer. There is no partial credit here.
**Best selection:** G1 — a Channels surface is the highest-value build remaining: account CRUD over existing routes, credential rotate/verify UI,
webhook-setup with reveal-once token discipline (same pattern as BYOK fingerprints), assistant binding picker with routability errors verbatim, widget
embed snippet view, per-channel health. Engine-complete; console-missing. Nothing in this list requires new engine endpoints on first reading —
**[needs verification]** per-route during build (the ledger's §0 rule).

### Step 9 — "Approve the refund." Approvals. **THE SECOND CLIFF.**

**Current:** engine has list + extend + owner/admin decision endpoints; console has nothing, and chat has no approval affordance either.
**Pause and think:** Company A's financial agent with `approval: required` tools produces work that nobody can approve. Runs stall at the approval gate
with no queue, no notification path visible to approvers (human-loop-notify exists engine-side — where does it surface? **[needs verification]**), no
expiry visibility, no extend action. For the financial agent this isn't polish — it's the control the auditors were promised.
**Best selection:** G2 — approvals center (queue over GET approvals, approve/deny over the decision endpoint, extend action, expiry flags) + inline
approval cards in chat. Verify the notify path surfaces somewhere a human looks.

### Step 10 — "Run three of these." Fleet life.

**Current:** fleet list with derived lifecycle + updated timestamps; per-agent everything.
**Pause and think:** with three agents, Company A needs: which are live/degraded/BLOCKed/paused at a glance (G11 — the health endpoint exists per
agent; the fleet doesn't show it); which documents serve which agents (reverse mapping — exists nowhere; derivable from snapshots per agent, N+1 but
fleet-small); drift signals (update_available exists per install — not shown in fleet).
**Best selection:** G11 — fleet health/degraded/update badges (console-only reads).

---

## 2. What v1 genuinely gets right (credit where verified)

- Contract fidelity: every setup route honored with exact shapes, headers, roles; errors verbatim with fix paths (live-verified across ~40 calls).
- Funnel keystones: install-never-publishes, draft concurrency without clobbering, draft evaluation unblocking required-checks, content-hash gates.
- Secret discipline: fingerprints/`hasCredentials` only, proof-free revoke, write-only OAuth secrets, secret scanner pre-persistence.
- No fake surfaces: five mock views deleted, no dead buttons, no simulated progress.
- Operate honesty: verbatim pause attribution, mandatory block reasons, proof-free kill, null-preserving metrics.
- Engine fixes landed with tests: R-1 DTO admission (+`history_limit` type fix), R-2 draft evaluation (+snapshot synthesis + executor pin scope), rollout id default migration, search limit coercion, addCases 422s, sourceRange object coercion.

---

## 3. Gap register (actionable; owners; verification status)

### CRITICAL

**G1 — Channel/deploy surface missing (console).** Engine: `channels.controller.ts` (full CRUD + rotate/verify/webhook-setup), `widget.controller.ts`,
`default_assistant_id` binding + routability (`channels.service.ts:43-46,454+`). Console: zero UI (verified by search). Build: Channels view (accounts,
rotation, verify action, webhook-setup with reveal-once token, assistant binding picker, widget snippet, health). Verify each route's exact shape at
build time. Templates' channel tabs should deep-link here.

**G2 — Approvals queue missing (console).** Engine: `approvals.controller.ts` (list + extend) + `POST :runId/approvals/:approvalId/decision`
(owner/admin, idempotent — `conversations.controller.ts:376-384`). Console: zero UI; chat has no approval cards. Build: approvals center + inline chat
cards. **[Needs verification]:** where `human-loop-notify` surfaces (if nowhere human-visible, that is itself a gap).

**G3 — Platform model catalog seeding (ops; launch-blocker question).** Dev `model_catalog_entries` is empty (verified); no seed script exists
(verified); entries are staff-managed. If prod is empty, every new customer's model picker is empty and nothing can ship. Actions: (1) confirm prod
seeding is a launch op with an owner; (2) console empty-state that says exactly that (not a generic empty message); (3) consider a minimum viable
seeded catalog as part of release.

### HIGH

**G4 — Brand voice decorative.** Verified zero runtime references (`mcp-authority.service.ts`, `manifest-resolution.service.ts`). Recommendation
(selected after considering removal): engine assembles `brand` into the system prompt with snapshot provenance (server-enforced, auditable, matches
the field's documented purpose); console keeps the field with "enforced at runtime" honesty. Alternative (if engine says no): delete the field, fold
guidance into instructions. A decorative control must not survive either way.

**G5 — Export→import round-trip broken over HTTP (engine, verified live).** `exportVersion` emits the full payload (instructions/model_params/
budget_policy included); `importVersion` service parses with the full `assistantPayloadSchema` (`assistants.service.ts:948`) — but `ImportVersionDto`
declares only schema_version + 5 policies + hash, so the forbidNonWhitelisted pipe 400s real envelopes (`property instructions should not exist`, …).
Fix (same class as ENG-1, service already correct): add optional `instructions?: string`, `model_params?: object`, `budget_policy?: object` to
`ImportVersionDto` + a pipe-level unit test mirroring `version-dto.test.ts`. Estimated: 30 minutes including tests.

**G6 — No cost visibility (engine + console).** `model-cost.service.ts` exists but is staff-plane only (no console route — verified); catalog entries
carry no cost fields. Makers set micro-budgets blind; burn-rate pauses arrive unexplained in money terms. Recommendation: console cost route (priced
preview where priced, "unpriced" labels otherwise — the ledger's rule) + cost fields on catalog entries. Until then, at minimum surface settled/
estimated cost from usage rollups where readable.

**G7 — No guided setup funnel (console).** Dashboard/welcome drop users without a next step. Build: org setup checklist from existing reads
(assistants? documents? usable models? published? serving channels once G1 exists?) + template-first entry. Console-only; highest leverage per effort.

### MEDIUM

**G8 — Eval authoring hostile to makers (console + 2 platform asks).** Case builder form (input.text + contains/not_contains/state_assertions/
document_ids + rubric) instead of raw JSON; disclose interim lexical-only scoring in plain words; run-plane health hint in the test panel (distinguish
"agent broken" from "runtime unavailable" — the dev `studio startRun unavailable` dead-letters prove the need). Platform asks: list endpoints for
dataset cases and candidate cases (add-only today; queues unbuildable without them).

**G9 — Knowledge librarian gaps (console + 1 verify).** Bulk upload queue; URL→sitemap helper; re-ingest-as-new-version (`target_document_id`
exists server-side, no UI); chunk preview drawer. **[Needs verification]:** tombstone resurrection via resync (believed true from deterministic
`ext-` slugs; prove live before promising).

**G10 — Operate observability (console).** Actor UUIDs → member names; known env/channel chips (from existing rows, no registry invented); per-agent
operate trail (**[needs verification]:** filtered audit read support).

**G11 — Fleet health picture (console).** Per-agent degraded/update/BLOCKed/paused badges in the fleet list (all reads exist).

### LOW

**G12 — Editor polish (console).** Live token counter vs the 20k cap; one-line guidance for model params; cost estimate when G6 lands.
**G13 — Test transport (console).** Test panel polls; chat streams over SSE — reuse the stream for test conversations when cheap.

---

## 4. What I deliberately did NOT recommend (and why)

- **Auto-registering missing tools at install.** Tools carry credentials and effect classes; silent registration is the wrong magic. The refusal +
checklist is the correct design.
- **Scheduled/embargoed publish.** Requires a worker + state machine the engine deliberately omits; manual publish-after-PASS is honest.
- **Per-resource ACLs, SCIM, cross-agent orchestration.** Out of scope per `agent-setup.md` §11; unchanged by this review.
- **Weakening required-checks for first publish.** The deadlock R-2 fixed was real; the gate doing its job on unverified content is not a bug.

---

## 5. Suggested build order (customer-value order, not ease order)

1. G3 verify (hours; blocks launch) → G5 fix (30 min, verified spec above) → G4 decision (engine, small) — unblock truth.
2. G1 channels surface (the last mile; engine-complete) + G2 approvals center (financial agent's control) — complete the job.
3. G7 funnel entry (multiplies everything) + G11 fleet badges (small).
4. G6 cost visibility (needs engine route; start the schema conversation now) + G8 case builder (console now, list endpoints asked).
5. G9/G10/G12/G13 polish queue.
6. Re-run this journey review after 1–4 with a real customer shadow session.

## 7. Implementation record (2026-09-17 — this goal loop)

Every gap built, step by step, no shortcuts. Engine + console. What follows is what shipped, what was proven live, and what remains honestly open.

### Engine changes
- **G5 (ImportVersionDto):** admits instructions/model_params/budget_policy/brand — export→import round-trips again (was 400 on every real
envelope). Pipe unit test added (`version-dto.test.ts`).
- **G4 (brand first-class):** `brand` (≤2000) in `assistantPayloadSchema`; `brand` columns on `assistant_versions` + `policy_snapshots`
(migration 0063); carried through create/createVersion/updateDraft/publish-rebuild/rollback-rebuild/insertPublishedVersion/
ensureVersionSnapshot/export (+`AssistantVersionExport`); covered by content hash AND manifest hash (`brand_voice`); composed into the served
prompt at assembly (`composeSystemPrompt`, pure + unit-tested) with `brandVoice` exposed separately on the manifest; DTOs admit it;
import strips top-level nulls so faithful exports re-normalize identically (also fixes null-instructions imports). Unit: `brand-payload.test.ts`.
- **0062 (live find):** `assistant_rollouts.id` had no DB default — every rollout/release write 500d. Migration + journal.
- **Search `?limit=` coercion (live find):** `@Type(() => Number)` on SearchDto (every limited search 400d). Pipe unit test added.
- **addCases 422s (live find):** safeParse per index instead of escaping ZodError as 500.
- **sourceRange object coercion (live find):** raw-SQL jsonb-as-text normalized in `rowToHit` (wire carried a JSON string).
- **RLS widget-plane fix (live find, severe):** `channel_accounts`/`channel_sessions`/`channel_events` are FORCE RLS; `db.root` sets no
context, so `getByPublicKey`, `getByIdForIngest`, session resolve/touch, conversation link, and ingest reads ALL returned null — the entire
public widget plane + inbound webhooks were dead. Fixed via documented `withBypass` (capability-keyed exact reads; `settle()` set the precedent).
- **Widget DTOs (live find):** decorator-less `MintSessionDto`/`WidgetMessageDto` 400d every widget message — declared shapes mirroring service
bounds (text 1..16000), exported for the pipe test (`widget-dto.test.ts`).
- **G6 (costs route):** `GET console/org/:orgId/models/costs` (all roles) → latest effective unretired point per provider/model
(`ModelCostService.listActivePoints`); empty = unpriced. Integration test with seeded rows (`model-costs.test.ts`).

### Console changes
- **G1 Channels** (`/agent-studio/channels` + nav + palette): accounts table (binding names, health, verify/webhook/rotate/edit/deactivate),
connect flow (4 credentialable platforms, binding REQUIRED, web origins REQUIRED, credential shapes verbatim), config editor, rotate modal,
webhook-setup with reveal-once token + loader snippet (absolute, origin-labeled) + callback URL, deactivate-with-consequences, serving explainer.
Template channel tabs deep-link here. Tests: `useSetupChannels.test.ts`.
- **G2 Approvals** (`/agent-studio/approvals` + nav + palette): queue with state filters, approve/deny (reason, audited), extend with future-time
enforcement, expiry flags, how-it-works panel. Notification popover deep-links `approval.requested` → approvals, `escalation.created` →
conversations. Tests: `useSetupApprovals.test.ts`. (Also fixed the decide path: it lives on RunsController — `/runs/…`, not `/conversations/…`.)
- **G7 funnel:** `SetupChecklist` on the dashboard (agents → knowledge → usable models → published → channels + approvals attention), live reads
only, hides when complete. **G11:** fleet degraded badges (60s-stale per-agent health). **G3:** empty-catalog states name the staff plane + support.
- **G6 display:** catalog price column (unpriced labeled, never zero-implied), editor chip price notes.
- **G8:** form-first case builder (HTTP vocabulary, JSON preview, caps) replacing raw JSON; lexical-scoring honesty lines (builder, runs panel,
evaluate panel); test-panel run-plane hint linking Status.
- **G9:** multi-file bulk upload (per-file slug/title rows, sequential authorize, per-file errors); sitemap locator (paste page URL → confirm
candidate → link → sync validates; no fake fetching).
- **G10:** member-name resolution (pause banners, blocks, version publishers), recent env/channel chips (local, labeled), per-agent audit trail
(action-prefix + client filter). **G12:** instruction token counter (estimated, labeled), temperature/top-p/reasoning guidance. **G13:** test-run SSE
live chunks (transcript stays source of truth) + Status hint on silence.
- **Brand flip:** mapping sends brand; caps ≤2000 (section: retrieval); editor copy states runtime enforcement; round-trip tests updated.

### Live verification (real OAuth account, owner org, HTTP — this session)
OAuth dance (PKCE + file-transport email) → trials → 20-template sync → upload→READY→inventory → tools upsert → install (pin refusal, then success)
→ health → draft test-run accepted → **draft evaluate returned eval_run_id + synthesized snapshot (R-2 over HTTP)** → required-checks 409 verbatim →
full-payload create (R-1) → If-Match update + stale-412 with both hashes → publish v1 + snapshot/hash parity → required-checks/BLOCK/retire/rollback/
export/import/discard/dup-name/draft-exists all verbatim → **brand create→publish→snapshot→export→import round-trip (G4+G5)** → rollout set (after
0062) → pause with attribution → release move → blocks CRUD → disable/enable → memories → datasets/cases (422 then {added:1}) → eval run → recall →
rename/collision/derived-slug → connectors link/refusals → BYOK step_up_required → **channels create→verify→webhook→snippet→re-bind refusal→deactivate→
reactivate** → **widget embed 200 → session mint → message accepted → conversation pinned to bound assistant with channel binding** (after RLS+DTO fixes).
Costs `{costs: []}` + approvals `{approvals: []}` + decide validation verbatim on the true `/runs/…` path.

### Gates
- Engine: `tsc --noEmit` clean; eslint 0 errors (2 pre-existing warnings in untouched lines); unit 32 files / 216 tests PASS; integration
targeted batch (model-costs, draft-eval, assistants, publish-gate) 17/17 PASS; full integration: only failure is `outbox.test.ts` "publishes…",
**proven pre-existing on the clean tree** (parallelism flake vs shared dev DB — passes alone); `npm run build` clean; migrations 0062+0063 applied.
- Console: `tsc -b` clean; eslint 0 errors/warnings on all touched files (full-src errors pre-existing in untouched tracks); vitest 26 files /
181 tests PASS; `npm run build` clean.
- Grep gates: zero `@neryva_data` in setup surfaces; zero `MODEL_CATALOG`; zero secret literals in views; If-Match on draft PUT; idempotent on
every setup mutation (DELETEs/authorize match routes without `@Idempotent`); wire keys only from `agent-payload.ts`.

### Honestly remaining (not hidden)
- Run EXECUTION needs the studio runtime plane (dev `deployment=off` dead-letters `run.created`); acceptance/pinning/snapshots proven, replies not
observable here. Same for eval decisions maturing and decide-on-parked-approval E2E.
- Costs are unpriced until staff seeds `model_cost_entries` (staff plane exists) — UI handles empty correctly.
- Platform asks (no endpoints; recorded, not built): dataset CASES list, candidate-cases list, memory-proposal queue list.
- Prod launch ops (cannot verify from here): platform catalog seeding (G3), `ENGINE_BASE_URL` for webhook/snippet hosts, Meta app credentials.
- Chat-inline approval cards: deferred (queue + notifications cover approvers); noted as follow-up.

## 6. Verification ledger for this review

- Read firsthand: channels controller/service (binding + routability), approvals controller + decision endpoint, import/export service + DTO,
eval case schema + provisioning translation, rollup metric keys, model-cost wiring, welcome routing, dashboard empties, chat binding, brand
references (absent), catalog seeding (absent), trial mutation, compliance view scope.
- Live-verified in v1 session (cited, not re-proven here): full funnel over HTTP with a real OAuth account (install/pins/test/eval/gates/
publish/rollout/release/blocks/kill/memories/search/rename/rollback/retire), plus the 4 engine fixes.
- Explicitly NOT verified (§0 items): tombstone resurrection, notify path visibility, filtered-audit support, prod catalog seeding, per-channel
health endpoints beyond verify. Each is labeled where used. No finding in this report depends on an unverified claim.
