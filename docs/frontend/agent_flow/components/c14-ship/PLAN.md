# C14. Publish — PLAN (STATUS: FINAL 2026-09-18)

> Depends on ALL of C01–C13. This is the money screen: readiness → publish →
> success. Every claim below cites `file:line` verified 2026-09-18 against
> current code. SPEC deltas are in §8; the SPEC itself is corrected at sign-off,
> never the binds.

## 1. Verified engine truth

Publish entry: `engine/src/modules/assistants/assistants.controller.ts:173-187`
(`@Post(':assistantId/versions/:versionId/publish')`, `@Roles('owner','admin')`
at `:174`, `@Idempotent()` at `:176`, body
`{ acknowledge_degraded_knowledge?: unknown }` at `:181`, strict `=== true`
at `:184`, returns `{ version: row }` at `:186` — the inserted
`AssistantVersion` DB row ONLY, no badge/decision/statement).

Service order (`assistants.service.ts`, `publish()` at `:693-802`):
1. `404` version-missing/mismatch (`:705-707`).
2. `400` status not publishable — `DRAFT/VALID/VALIDATING` allowed (`:708-710`).
   PublishPanel's `:79` filter is CORRECT (audit D6 withdrawn).
3. `400` payload invalid incl. secrets (`:727-730` → `validation.ts:162-175`).
4. `400` unknown models / residency (`:1248-1309`; skipped silently when the
   config-publish surface is unavailable, `:1261-1267` — client must treat
   catalog-absent as unknown, never as pass).
5. `400` instructions empty (`validation.ts:182-190`; the code comment says
   "Typed 422" but the throw is `ApiError.validation` = HTTP 400 per
   `api-error.ts:127-129` — comment is stale, code is 400).
6. `400` tool pins rejected (`:1316-1352`; enabled-row + fresh-hash check,
   built-ins skipped at `:1335-1338`, message verbatim
   ``tool pins rejected: ${problems.join('; ')}`` at `:1349`).
7. TX opens with `pg_advisory_xact_lock` (`:735-738`); version numbering
   `max+1` over PUBLISHED with RETIRED-aware fallback (`:740-763`).
8. `409` no-op joint guard (`:1844-1896`; throws at `:1884`
   `'assistant active version already carries this payload'` for
   legacy/null-manifest, and at `:1889-1890`
   `'...already carries this payload and resolved set'` for joint match;
   compares content `hash` AND `manifestHash` against the ACTIVE pointer only
   (`:1866-1873`); prompt/params excluded from the manifest (`:1852-1854` →
   prompt-only edits ALWAYS publish; same-content + drifted manifest falls
   through at `:1888` = legitimate re-publish/re-pin).
9. `409` BLOCK (`rejectBlockedContent :1829-1842` → `release-gate.ts:28-40`,
   message verbatim at `:34-35`, latest-wins, content-hash keyed, shadow
   excluded at `:111`).
10. `409` required-checks (`rejectUnmetRequiredChecks :1803-1819` →
    `release-gate.ts:48-63`; message verbatim at `:60` with
    `details: { required_checks, latest_decision }` at `:61`; required list is
    STRING-only server-side (`:96-98` filter); no-declared = legacy posture
    (`:52-54`); WARN/BLOCK/absent all refuse).
11. `400` degraded gate (`:1604-1619`; unresolved + undercovered pins join ONE
    gate; message names slugs + indexing progress; ack waives both).
12. In-TX insert: version row (`:1620-1643`) + snapshot (`:1649-1668`) +
    active-pointer swing (`:1680-1700`); "provenance in-TX" is WRONG —
    provenance is a DERIVED read (`:1090-1150`: snapshot + template + latest
    eval run), only the snapshot is written in-TX. In-flight runs stay pinned:
    never touched (`conversations.service.ts:722` — "in-flight runs are never
    touched here"; runs pin `policySnapshotId` at accept,
    `conversations.service.ts:431`).
13. Degraded publish starts a 7-day clock (`degradedUntil +7d`,
    `degradedReason ≤512`, `:1670-1689`); healthy publish clears it
    (`:1690-1700`). Post-commit audits: `assistant.published` (`:779-791`) +
    `assistant.publish_degraded_acknowledged` gated on the flag (`:1534-1535`,
    `:1552-1558`, called at `:792-797` publish and `:944-949` rollback).
14. Rollback (`controller.ts:235-247`, `@Roles('owner','admin')` at `:236`,
    `@Idempotent()` at `:238`, `to_version_id` REQUIRED, ack accepted at
    `:245`) runs the SAME gate stack (no-op/BLOCK/required/degraded apply to
    restored content — content-hash keyed, §7 D6 of release-gate).
15. Status vocabulary: `ApiError.validation` = HTTP 400 (`api-error.ts:127`),
    `conflict` = 409 (`:135-137`, `retryability: no-retry`), `precondition` =
    412 (`:140-144`). **NO 412 exists on the publish/rollback path** —
    OCC/`If-Match` lives ONLY on `PUT .../draft` (`controller.ts:135-143`,
    `service.ts:426-427,464-470,1969-1983`). Publish concurrency = advisory
    lock + no-op 409 (§8 D2).
16. No dedicated required-checks endpoint exists: `getVersionProvenance`
    returns `{ template, manifest_hash, update_available, last_evaluation }`
    (`service.ts:1094-1101`, eval verdict at `:1145-1147`); the required list
    lives on the template row (`schema.ts:324` `release_policy`) readable via
    `GET assistant-templates/:slug` (`templates.controller.ts:29-35` →
    `templates.service.ts:115-135`). The 409 `details` carry
    `required_checks + latest_decision` at refusal time only (§8 D1).
17. Channels: zero `returnTo` in `src/modules/channels/*` (only OIDC login
    carries one); channels require a pre-existing agent via
    `config.default_assistant_id` (`channels.service.ts:43-44`), existence
    enforced at `:472-475`, template channel-binding check at `:477-487`
    (§8 D4 — console plumbing is greenfield).

## 2. Research synthesis (finding → decision)

Sources: BugMojo go/no-go playbook 2026-06-05; Kiolo readiness checklist
2026-07-19; StackPractices PRR template 2026-06-26; AQAPro release template
2026-06-14; Smashing Mag disabled-buttons 2021 + NN/g + Roselli 2024 +
Jakob Nielsen 2025-11-13 + 72Technologies 2026-06-06; LogRocket reversible
actions 2025-12-03; FMP publishing safety loop (laioutr) 2026; Vercel instant
rollback; DEV provenance-gate 2026-08-17.

- R1 (blocker taxonomy written BEFORE release day: blast-radius × severity ×
  reversibility; cosmetic-with-workaround never blocks — ledger §4 C14):
  → the readiness card splits REQUIRED (engine gates §1.1-11) from ADVISORY
  (everything else); no advisory row may disable or redden the publish
  action. Phantom SPEC gates (approvals, control-blocks, drift-as-refusal)
  are NOT rendered at all (§8 D8) — a row for a non-gate is an invented
  state.
- R2 (readiness is Go / Conditional-Go-with-named-exceptions / No-Go, never a
  bare percentage — AQAPro's 80–99% amber notwithstanding, the ledger's
  decision trumps for the verdict line): → the card header renders exactly
  those three verdicts; degraded-ack flips No-Go → Conditional-Go with the
  named exception + audit note. No percentage anywhere.
- R3 (every blocker carries a reproduction so triage decides instead of
  investigates): → every failing REQUIRED row carries its fix path inline
  (route + action: evaluate-this-version, map-pins, re-pin-tool, pick-model,
  write-instructions) — never a bare message.
- R4 (disabled buttons are a UX bug: always-clickable + `aria-disabled` +
  focus-moves-to-first-error; Nielsen 76% disabled-WITH-explanation; SPEC
  bind "publish click with open issues scrolls to first — never dead click"):
  → the Publish button is NEVER `disabled` for readiness reasons (only
  `aria-disabled` + full contrast); clicking with open issues smooth-scrolls
  to + focuses the first failing row and announces via `aria-live`. True
  `disabled` is reserved for: role-deny (with explained row + request path
  beside it), no-draft-at-all, and in-flight pending (label swaps to
  `Publishing…`, the duplicate-submit guard Panel already documents at
  `PublishPanel.tsx:19-20,227`).
- R5 (provenance receipts: publish is the moment evidence must be all in one
  place — DEV gate; moltbook claim-receipts): → the publish rail + success
  screen carry the receipt: content hash (16), schema version, snapshot note,
  template badge, eval decision ON THAT HASH with timestamp, degraded
  statement. Success composes from `version` row + provenance + template
  reads (§1.13) — never claims the POST returned more than it did.
- R6 (rollback-first-debug-later; rollback creates a NEW deployment/record,
  is confirm-gated with target preview, records a reason in history —
  LogRocket/Vercel/Devpilot/FMP): → rollback gets a version PICKER (newest
  PUBLISHED ≠ active — the current no-picker newest-only path in
  `VersionsPanelActions:53-126` is a silent-target defect), a confirm showing
  the rollback TARGET (version + hash + published-at), an optional reason
  field recorded in the audit details, and post-success copy "live is now
  vN" (FMP's unambiguous-state rule). "Rolled back" is never a status
  (README #19 — rollback births a new version; the panel says so).
- R7 (5-minute rollback target; recovery feasibility + data consequences
  stated; rollback does NOT revert external systems — Octopus/Devpilot):
  → the rollback confirm states what rollback does NOT touch (in-flight runs
  stay pinned; no data/external revert) — engine-truth copy from §1.12.
- R8 (failure reverses ceremony with the exact issue in a whisper — ledger):
  → every typed refusal (409 ×3 shapes, 400 ×4 shapes) renders its branch:
  exact message + named fix + deep link; the ceremony (confirm/success)
  reverses to the readiness card with the failing row focused.

## 3. Builder placement

Ship SPINE (existing `slot-model.ts` `SpineId`, `SPINE_META.ship`,
`BUILDER_STEP_ANCHORS.ship='publish'`). New `ShipSection.tsx` in
`builder/inspector/` — the quick path: readiness card + publish rail +
degraded ack + confirm + inline success. NO new shortcut (registry check:
`Esc N T G B E ⇧K ⇧M S M K Del ⌘S Space` all taken; publish executes from the
section via pointer, exactly like today's detail panel — no key needed, no
lock-test touch). `SLOT_PASS.ship='C14'` tag resolves to the real section.

## 4. Pure model first (`builder/lib/publish-model.ts` + `.test.ts`)

Bounds/labels/copy constants, zero engine imports:
- `PUBLISHABLE_STATUSES = ['DRAFT','VALID','VALIDATING']` (from §1.2).
- `classifyPublishRefusal(status, code, message) → 'no-op' | 'blocked-content' |
  'required-checks' | 'degraded' | 'status' | 'payload' | 'models' | 'tools' |
  'instructions' | 'unknown'` — matches the two no-op messages verbatim
  (§1.8), the BLOCK prefix (`the latest evaluation of this content decided
  BLOCK`), the required prefix (`release policy requires a fresh PASS`),
  the degraded key (`knowledge_pins`), else by HTTP status (409→unknown-gate,
  400→payload). Each maps to `{ title, fixRoute, fixLabel }`.
- `evaluateRequiredGate(required: Array<string|object>, decision, freshness) →
  { state: 'pass' | 'fail' | 'not-declared', failingObjects: string[] }` —
  reuses `eval-model.ts` `describeRequiredCheck` for object rendering (never
  joins mixed arrays — C10 law), PASS-only passes (WARN fails), freshness via
  the timestamp rule (C10: decision is for THIS content — the caller passes
  whether the decision's hash/timestamp covers the draft).
- `detectNoChangeHint(draftDefinition, activeDefinition) → boolean` —
  deep-equal ⇒ advisory muted `No changes to publish` state ONLY (button
  stays live: same-content + drifted-manifest is a legitimate re-publish,
  §1.8 — a blocking pre-empt would strand re-pinning).
- `DEGRADED_ACK_COPY`, `SUCCESS_COPY`, `ROLLBACK_COPY` (incl. what-rollback-
  does-not-touch), role-denied copy via existing `capabilities.ts`.
- Verdict: `readinessVerdict(rows) → 'go' | 'conditional-go' | 'no-go'` (R2).

## 5. Hooks (extend, never duplicate)

- NEW `usePublishReadiness(agentId, versionId)` in
  `hooks/studio/useAgentAuthoring.ts` (beside `usePublishVersion:421-434`):
  composes `useAssistantVersions` + `useVersionProvenance:216-225` +
  `useAssistantTemplate` (`useSetupTemplates.ts:200-216`) +
  `useModelAvailability` + `useToolCatalog` + **`useKnowledgeHealth:260-269`
  (ACTIVE pins — the projector + OperatePanel source; PublishPanel's
  `useDocuments` library-state source at `:71,114-122` is replaced)** +
  eval freshness via `eval-model.ts` (`evalFreshness`,
  `selectVersionEvalState` — C10 precedent, never re-derived). Returns
  `{ rows, verdict, publishable, needsAcknowledge, noChangeHint,
  degradedDetail, isPending, isError, retry }`. Single derivation consumed
  by BOTH the ship section and the detail panel (§6 law: no second
  derivation).
- `usePublishVersion` (`:421-434`): keep endpoint/payload/`idempotent:true`;
  ADD typed success (`{ version: AgentVersion }` — today `unknown`) and stop
  swallowing typed errors (today `toastEngineError` only at `:432` — the
  callers need the status+body for §4 branches; keep the toast as fallback).
- `useRollbackAssistant` (`:447-464`): same typing treatment; ack passthrough
  kept.
- `useInvalidateAuthoring` (`:318-323`): publish/rollback success
  additionally invalidates `['studio','provenance']`, eval-run lists, and
  operate keys (today assistants-only — pointer swing leaves them stale).
- Channels (greenfield, §1.17): `routes.tsx` `validateSearch`
  `{ returnTo?: string, assistantId?: string }` on the channels route +
  `ChannelsView`/`ConnectModal` preselect + post-create `navigate(returnTo)`.
  Additive only.

## 6. Projector + page deltas (grading truth table)

`projector.ts:512-526` ship spine today: hardcoded `untouched`/`locked`.
New: ship grades from `usePublishReadiness` —
| readiness | slot status | subtitle |
|---|---|---|
| locked (no agent yet) | `locked` | `Create the agent first` (kept) |
| reads pending | neutral loading | `Checking gates…` (skeleton, never red) |
| verdict go | `ready` | `All gates pass — ready to publish` |
| verdict conditional-go | `info` | `Degraded ack armed — publish ships degraded (audited)` |
| verdict no-go | `attention` | `N blockers — publish explains on click` (never `error`: attention is the publish-refuses color per purpose/brain/knowledge precedent `:404-433,:396-491,:187-266`) |
Verdict leg: NO bottom-action rule (SPEC demands no canvas hint; publish
executes from the section/panel — ledger Step 4.3 "ONLY if gating demands a
hint"). `BuilderBottomBar`/`AgentBuilder.handlePrimary` untouched.

## 7. Variants & gates

- Empty: no drafts → `No publishable draft — save one in the editor first`
  (kept copy, `PublishPanel:141`); no versions at all → same.
- Loading: skeleton rows + neutral subtitle; button live-but-`aria-disabled`
  (server decides — R4); projector neutral-while-loading (§6).
- Error: reads fail → error row with `retry` (from the hook); publish stays
  clickable, server verdict rules, refusals render verbatim (R8).
- Denied (developer/billing/reader): explained row (required role
  owner/admin + request path via `capabilities.ts`), button truly disabled
  with the explanation BESIDE it (R4 permission exception); test/evaluate
  stay developer-open (SPEC roles line).
- Conflict: 409 no-op → `No changes` branch (link to active version +
  re-pin note); 409 BLOCK → evaluate-this-version branch; 409 required →
  fix branch with `required_checks + latest_decision` from `details`;
  400 degraded-without-ack → arm the ack inline (failure reverses ceremony,
  whisper states the exact issue); 400 status/payload/models/tools/
  instructions → row-focused branch each.
- Role matrix: publish/rollback/retire owner+admin; draft-edit/test/evaluate
  owner+admin+developer; reads all roles (README global contracts).

## 8. Corrections log (SPEC deltas found in Step 1)

- D1 (required set): SPEC "render from the required-checks READ" — NO such
  endpoint exists (§1.16). The read is COMPOSED (provenance.lastEvaluation +
  template.releasePolicy.required + local caps/models/tools/health checks),
  which is what `usePublishReadiness` (§5) implements. SPEC wording corrected
  at flip.
- D2 (412): SPEC "412 on stale draft → merge-or-reload" DOES NOT apply to
  publish/rollback — no `If-Match` on either route (§1.15). Merge-or-reload
  stays on the draft-edit path only. Confirm dialogs carry no 412 branch.
- D3 (success): SPEC "success = version + hash + template badge + eval
  decision + degraded statement" — the POST returns `{ version: row }` ONLY
  (§1.13). Badge/decision/statement are composed from provenance + template
  reads in the success screen. SPEC wording corrected (response vs composed
  receipt).
- D4 (channels): SPEC "connect channel (with `returnTo`)" — no `returnTo`
  exists anywhere in channels (§1.17). C14 builds the console plumbing (§5);
  the engine needs nothing (channels already require a pre-existing agent).
- D5 (provenance): SPEC "snapshot/provenance in-TX" — only the snapshot is
  written in-TX; provenance is a derived read (§1.12).
- D6 (gate lines): SPEC `release-gate.ts:32-62` → actual `:28-63`
  (message `:34-35`, required `:58-62`, throw `:121-122`); controller cites
  hold (`:173-176,:235-238,:249-252` verified exact).
- D7 (PublishPanel audit): required logic drops OBJECT checks
  (`PublishPanel:125` filters strings — mixed arrays never joined, C10 law),
  treats WARN as fail implicitly, no freshness check, loading
  `decision=null` false-negatives red, `publishable` covers caps-only
  (`:132` — red rows don't gate), no success/no-op/409 branches — ALL fixed
  by the §5 rewrite-over-shared-hook (file kept, derivation replaced).
- D8 (phantom gates): SPEC required-set lists "tool approvals satisfied; no
  blocking control blocks; no schema drift" — NONE is a publish gate in code
  (zero `control.?block|approv` hits on the publish path; drifted manifest =
  legitimate re-publish §1.8). They MUST NOT render as required rows
  (honesty law §6.7). SPEC line corrected at flip.
- D9 (comment staleness): `validation.ts:184-185` "Typed 422" vs actual 400;
  `AgentDetailView.tsx:61-72` "publish (step-up)" vs actual no-step-up
  (`useAgentAuthoring.ts:416-420` justifies direct call). Noted, not fixed
  here (out of C14 scope; D9 filed, not silently re-scoped).

## 9. Dedicated surface plan (keep-vs-extend verdicts)

- `PublishPanel.tsx:1-265` — KEEP file + mount, REWRITE derivation over
  `usePublishReadiness` (§5): true `publishable` (= all REQUIRED pass or
  acked-degraded), object-check rendering, WARN≠PASS, freshness/staleness
  row, ACTIVE-pins health source, no-change advisory state, typed 409/400
  branches (R8), shared `PublishSuccess` screen (receipt §2 R5 + 3 exits +
  provenance footer + audit link), developer explained row. Confirm copy kept
  (atomic-pointer + in-flight-pinned) + degraded-lifecycle line (7-day clock,
  §1.13 — operators must know the waiver expires).
- `VersionsPanel.tsx` row Publish (`:224-233`) — ALIGN: direct mutate with no
  gates/ack/confirm/role-check is a second publish path that disagrees with
  the gate panel. Decision: the row button becomes "Review & publish" —
  selects the draft in the gate panel + smooth-scrolls to it (same fix-path
  pattern as R4 scroll-to-first; one publish path, zero forks).
- `VersionsPanelActions:53-126` rollback — EXTEND: version PICKER (PUBLISHED
  ≠ active; fixes silent-target), target-preview confirm (§2 R6), optional
  reason → audit details, degraded-ack passthrough via readiness, typed
  refusal branches, "live is now vN" post-copy. No picker = no ship.
- `AgentDetailView.tsx:338-344` — KEEP layout; ADD success-state CTAs
  (`View channels` with returnTo, `Back to operate`, `Test active`) — the
  audit proves publish is a dead-end today (§4 of audit).
- Channels — ADD `returnTo` plumbing (§5); no engine change.

## 10. Explicit non-goals

- Staged rollout/canary-at-publish, traffic weights, pause/resume (C15 owns
  operate; publish ships the pointer, nothing more).
- Promotion-gate changes (separate inline gate, C10-locked, no shadow
  exclusion — untouched).
- Approvals/blocks/drift as publish UI (not engine gates — §8 D8; rendering
  them as gates would be invented states).
- Publish retry controls (idempotent replay is automatic via `@Idempotent()`;
  no button needed).
- Unpublish/delete-from-published (no such verb; retire lifecycle is C15).
- Second derivations of readiness anywhere (one hook, §5 — a fork is a
  defect per §6.6).
- `validation.ts:184` + `AgentDetailView:61-72` stale comments (D9 — filed
  above, fixed when those files are next touched, never copied).

## 11. Query-key + invalidation plan

Reads (all `['studio', …]` single-source, warmed by existing hooks):
`assistants` (versions/definitions) · `provenance` (per version) ·
`assistant-templates` (+ `releasePolicy`) · `model-availability` · `tool-catalog` ·
`knowledge-health` (ACTIVE pins — replaces `documents` for this surface).
Writes: publish/rollback success → invalidate `assistants` (existing
`:318-323`) PLUS `provenance`, eval-run lists, operate keys (§5 — pointer
swing otherwise leaves them stale). No new cache families; health/catalog
stay single-source (no warming duplicates).

## 12. Shortcut impact

NONE. No new shortcut; no moved shortcut; the shortcut-map lock test
(C09) untouched. Ship executes via pointer from the section/panel (same as
today's detail panel). Rationale recorded: publish is a confirm-gated money
action — keyboard-summoning it risks the tap-through training the C06 card
laws forbid.
