# C15. Operate — PLAN (STATUS: FINAL 2026-09-18)

> Last component. Depends on C14. Detail-after-publish surface + builder
> re-entry only (no new inspector section). Every claim cites `file:line`
> verified 2026-09-18. SPEC deltas in §8; the SPEC is corrected at sign-off,
> never the binds.

## 1. Verified engine truth

- Lineage: create forks ACTIVE (`assistants.service.ts:343,384`); updateDraft
  REBASES onto active (`:439-446,460`); publish inherits (`:773-774`);
  rollback-as-new points at the restored target (`:926-927`);
  `parentVersionId` is a plain uuid, no FK (`schema.ts:108`); provenance
  carries `parent_version_id` (`:1148`; SPEC range `1100-1148` drifts ~10
  lines, end exact). Install/definition-create set no parent (implicit null).
- Rollouts: weights sum exactly 100 (`rollouts.service.ts:51-54`); variants
  `{version_id, weight}` (`schema.ts:230,251-254`); routes `GET/POST rollout`
  + `POST rollout/pause` (`rollouts.controller.ts:21,26,45`); **NO resume
  route — resume = re-set** (`POST` set / `PUT releases`,
  `releases.controller.ts:34`, `rollouts.service.ts:150-162`); paused rows
  carry `paused_reason(512)/paused_by(128)/paused_at` (`schema.ts:219-221`,
  NULL = operator-paused-legacy per `:213-216`); manual pause writes reason
  literal `'operator'` + actor in `paused_by` (`rollouts.service.ts:205-207`
  — SPEC "manual = actor" is imprecise); burn pause writes
  ``burn_rate: last-hour $… exceeded threshold $…`` + actor
  (`burn-rate.service.ts:224-226`); burn is service-only, hourly worker
  (`billing.worker.ts:107-111`), **no burn endpoint**.
- Degraded lifecycle: columns (`schema.ts:41-43`); set +7d with
  `reason≤512` (`service.ts:1684-1686`); clear on healthy publish
  (`:1695-1697`); sweep fn at `:1717` (SPEC `1708-1773` drifts — comment at
  `:1706`): overdue `degraded_until < now() AND disabled_at IS NULL`
  (`:1728-1732`) → auto-suspend via `setDisabled` (`:1741-1748`); due-soon
  `< now()+24h AND degraded_alerted_at IS NULL` (`:1757-1761`) → warn-once
  mark (`:1771-1773`).
- Rollback: owner/admin (`controller.ts:235-237`); ack accepted
  (`dto.ts:196`); cannot target a DRAFT (`service.ts:877-878`); births a
  PUBLISHED row with `rollbackOf` (`:1627`). Retire: owner/admin
  (`controller.ts:249-251`); cannot retire the ACTIVE version — 409 with
  the successor-first copy (`service.ts:836-842`). Disable/enable:
  owner/admin (`controller.ts:62-63,82-83`); default reason
  `'operator kill switch'` (`service.ts:303`). Delete: 409
  `'assistant has conversations — archive them before deleting'`
  (`service.ts:274`; SPEC `:254` drifts). Statuses: the enum DOES contain
  `'ROLLED_BACK'` (`schema.ts:284-291`) but no writer ever sets it
  (historical, never reused — `:67`, only RETIRED at `:846`); UI must never
  expect it on rows.
- Reads: knowledge-health `{degraded, pins[]}` with
  `degraded = !resolved || state!=='ready' || embedding_complete===false`
  (`controller.ts:122-127`, `service.ts:548-556,659-661`); eval runs
  (`harness-parity.controller.ts:102-123`), shadow excluded from provenance
  (`service.ts:1134`), `is_shadow` default false (`eval.schema.ts:91`);
  credentials revoke with `{reason, compromised}`
  (`provider-credentials.controller.ts:98-117`); models + costs reads
  (`model-catalog.controller.ts:22-39`).
- Audit (exact strings): `assistant.created` `:172`,
  `assistant.version_drafted` `:181,:395`, `assistant.version_redrafted`
  `:476`, `assistant.version_draft_discarded` `:528`,
  `assistant.published` `:780`, `assistant.publish_degraded_acknowledged`
  `:1552`, `assistant.rolled_back` `:932`, `assistant.retired` `:855`,
  `assistant.disabled|assistant.enabled` `:320`, `assistant.deleted` `:263`,
  `assistant.eval_started` `:1041`, `assistant.test_run_started` `:1494`,
  `assistant.degraded_warning` `:1777`, `assistant.auto_rollback`
  (`burn-rate.service.ts:244`), `assistant.rollout_paused`
  (`rollouts.service.ts:215`), `release.promoted` (`:174`),
  `approval.extended` (`conversations.service.ts:1760`),
  `control.block_set` (`:78`), `control.block_cleared` (`:99`).
- **Audit query is EXACT-match on action**
  (`org-audit.service.ts:51-53` — the "prefix filter" comment is stale).
  Consequence: the console `AgentTrail` query `action:'assistant.'`
  matches NOTHING in production — the trail is empty outside mocked tests
  (§8 D8, fixed here: unfiltered fetch + client-side prefix set).
- Approvals: states PENDING|APPROVED|DENIED|EXPIRED, `?state=` the ONLY
  server filter, cap 200 newest-first, `expired` read-computed
  (`conversations.service.ts:1686-1721`); extend PENDING-only + audited
  (`:1737-1764`, 409 when not pending); decide
  `POST runs/:runId/approvals/:approvalId/decision {decision!, reason?}`
  (`conversations.controller.ts:376-399`, reason persisted with
  `?? 'approval_denied'`, `mcp-authority.service.ts:1236,1251`) — **reject
  MAY require a reason (endpoint-supported)**; approver chain clamp 1–5
  (`mcp-authority.service.ts:535`); the LIST returns NO reason column
  (`:1698-1710`) — queue history shows actor + time, reasons live in
  audit/runs (linked, never claimed inline).
- Memory proposals: decide-only endpoint, PENDING-only, audited
  (`knowledge.controller.ts:206-225`, `memory.service.ts:157-167,209`);
  **NO list query exists** — no queue is buildable without an engine read.
- Escalations: `GET ?state=WAITING|CLAIMED|RESOLVED` (all-reader+), escalate
  / claim (owner+admin+developer) / assign (owner+admin) / resolve / reply
  (`escalations.controller.ts:22-125`); **zero console reads or UI**.
- Blocks: CRUD owner/admin (`control-blocks.controller.ts:17-50`); reason
  1–512 MANDATORY (`service.ts:52-54`); expiry ISO-or-null (`:55-62`);
  ACTIVE = `expires_at IS NULL OR > now()` (`:129`, no sweeper); platform
  template-blocks are a STAFF-guarded separate read
  (`fleet.staff.controller.ts:103-108`) — the console cannot render
  staff-read-only rows (no invented join).
- Observe: `GET analytics/rollups?kind&days&assistant_id`
  (`harness-parity.controller.ts:181-192`), kinds `usage_daily`,
  `assistant_outcomes_daily` (containment), `assistant_csat_daily`
  (`analytics-rollup.consumer.ts:103-169`); **no per-assistant trace
  endpoint** (OTel + per-run reads only); **no per-assistant channel
  read** (org-scoped; client filters `config.default_assistant_id`).

## 2. Research synthesis (finding → decision)

Sources: Vercel Geist Project Banner; Kestra kill-switch; Anvil PausedBanner;
Supabase smart incident banner 2026-02-23; InstaNode maintenance banner;
Zenmanage canary + progressive rollout playbooks; Datadog + LaunchDarkly
guarded rollouts; Featureflip kill-switch; Connic approvals; Agent Native
HITL pattern 2026-03-13; AxonFlow HITL docs 2026-08-26; agent-action-shield;
Platos approvals; Kailash ADR-0051 version history; Apache Superset version
history UI; Gaffer history webview; codeframe PRD history.

- R1 (banner laws — Geist: ONE banner at a time, non-dismissible while the
  state stands, always a resolving CTA, variant carries severity; Supabase:
  visibility computed in a pure, tested util): → the operate header shows
  the single most severe banner (disabled/error > degraded-warn > paused >
  drift/shadow-info), each with its fix CTA; banner choice is a pure
  `pickOperateBanner` (tested), never stacked competing banners.
- R2 (kill switch — Kestra: scoped lever + auditable who/when/why + visible
  banner; canary playbooks: "pause first, investigate second"; kill switch
  reserved for critical/global): → Day-1 strip stays EXACTLY two toggles
  (ledger lock) with confirm naming the target; pause keeps serving the
  pre-rollout fallback (stated); disable keeps the engine-default reason
  path (optional reason input, never mandatory — the engine default is the
  honest copy).
- R3 (guarded rollouts — LaunchDarkly/Datadog: per-metric tiles with
  difference-vs-baseline, pause-or-stop on regression, notifications;
  Zenmanage: manual gates for risky paths, soak-then-advance, resume at the
  same stage): → the rollout card keeps variants + weights + pause/resume
  and GAINS guardrail evidence links (Observe kinds + last eval decision);
  resume = re-set at the same variants (engine truth §1 — no resume
  endpoint); no auto-advance exists to show (stated once, not a missing
  feature).
- R4 (lineage — Kailash: drawer + progressive disclosure + rollback-creates-
  new; Superset: timeline + preview + restore-as-new + Current badge;
  Gaffer: timeline grammar + tiered confirms): → a compact lineage STRIP
  (linear chain + rollback forks via `parent_version_id`/`rollbackOf`,
  Current badge, empty-awaiting states) on the operate header — NOT a full
  graph (chains are linear; VersionsPanel diff already covers compare).
- R5 (approvals — Connic: pending-first with full context + audit + trace
  linkage; Agent Native: payload-locked review, reject REQUIRES reason,
  searchable append-only log; AxonFlow: merged planes with badges, routed
  decisions): → payload drawer (summary/action/policyVersion/runId/expires/
  age — the full listable context, never invented payload args); reject
  requires a reason (endpoint-supported §1); history shows actor + time
  (reasons live in audit — linked); run→trace link; per-row pending;
  polling while PENDING; loud missing-runId error (never silent null).
- R6 (aggregate-vs-separate — AxonFlow merges WITH plane badges only where
  both planes are readable): → SEPARATE destinations. Non-emptiness is
  data-dependent and unprovable from code (EXPIRED/DENIED may be empty);
  memory has no list read; escalations have no console reads at all.
  Merging would strand empty planes and hide the only queue. The approvals
  card pattern stays the reference for future queues (documented §9).

## 3. Builder placement

Re-entry ONLY — no new inspector section (ledger §4 C15). Additive
`?slot=` search on the build route (`routes.tsx` validateSearch, same shape
as channels `returnTo`): `AgentBuilder` selects the slot on mount when the
value names a real spine/satellite (unknown → ignored, never an error).
Operate draft card links `buildAgentBuildPath(id)?slot=<first-blocker-slot>`
with readiness row→slot map (shape→purpose, models→brain, tools→tools,
block/required→evaluation, knowledge→knowledge). No shortcut, no lock-test
touch, no bottom-action change.

## 4. Pure model first (`builder/lib/operate-model.ts` + `.test.ts`)

Bounds, labels, copy constants; engine imports none:
- `pickOperateBanner(states) → {tone, title, detail, cta} | null` — severity
  order disabled > degraded-past-due/suspended > degraded-due-24h >
  degraded-active > paused > drift/shadow-info (R1; pure, clock-injected
  `nowMs` like `isBlockActive`).
- `degradedBannerState({degradedUntil, disabledAt}, nowMs) →
  'none'|'active'|'due-24h'|'past-due-suspended'` (sweep semantics §1).
- `describePausedRollout({pausedReason, pausedBy, pausedAt})` — manual
  (`'operator'` + actor) vs `burn_rate:` vs NULL-legacy, verbatim copy
  (single source with OperatePanel's `pausedBanner` — the panel adopts it,
  never two wordings).
- `buildLineage(versions) → {nodes, edges}` — linear chain by
  `parent_version_id` + rollback forks via `rollbackOf`, Current badge
  target, orphan-safe (missing parent → root note, never a crash).
- `APPROVAL-copy`: age wording (`Expires in N / Expires tomorrow`), reject-
  reason requirement copy, missing-runId error copy.
- `OPERATE_COPY`: emergency confirm lines (pause = fallback-serving note;
  disable = engine-default-reason note), resume line (re-set at same
  variants), no-resume-endpoint note, kill-switch scope note.

## 5. Hooks (extend existing; exact functions)

- `parseVersions` (+`parentVersionId`, tolerant absent→null) and
  `parseDetail` (+`degradedUntil/degradedReason`, tolerant) in
  `useAgentAuthoring.ts` — additive fields, zero shape churn.
- `useRollout/useSetRollout/usePauseRollout/useMoveRelease/useReleasePointer/
  useControlBlocks/useSetControlBlock/useClearControlBlock/useMemberNameMap/
  useAnalyticsRollups/useChannels/useAudit/useAuditFacets` — used AS-IS
  (resume = `useSetRollout` with current variants; pointer = read-only
  `useReleasePointer`; NO `useResumeRollout` is created — it would invent
  an endpoint).
- `useApprovals` — ADD `refetchInterval` option (poll while the queue shows
  PENDING; default off — libraries stay quiet). Per-row pending comes from
  per-row `useDecideApproval()` instances (no hook change).
- `useDecideMemoryProposal` — untouched (no list read exists to pair it).
- No new cache families; operate/approvals/audit keys stay single-source;
  pause/resume/set/move/disable/decide/extend/blocks writes keep their
  existing invalidations (+ eval-list invalidate on resume already covered
  by operate-key invalidation).

## 6. Projector + page deltas

NONE for the canvas (no new slot/section). `AgentBuilder` delta ONLY: honor
`?slot=` on mount (select spine/satellite by id-or-kind, unbound kind =
  no-op — the `onEditJump` rule verbatim). Subtitle/hint/status code
  untouched.

## 7. Variants & gates

- Empty: no rollout (kept "no rollout" editor state); no versions; approvals
  per-filter empties (kept copy); trail with zero matching events (honest
  "newest 100 org events" scope note + Audit link); lineage single-node.
- Loading: skeletons (panels keep theirs); banner area neutral-while-loading
  (never red on unknown).
- Error: rows keep error+retry; banner area hides on read failure (a banner
  must never render from failed reads).
- Denied: role matrix — operate writes (pause/set/move/blocks/disable)
  owner/admin with explained rows (existing `canOperate` pattern kept);
  reads all roles; approvals list author+, decide govern+ (kept).
- Conflict: BLOCK-gated promote (kept); retire-active 409 (kept copy);
  extend-non-pending 409 (surfaced, not toasted-away); delete 409 (kept).

## 8. Corrections log (SPEC deltas found in Step 1)

- D1 (resume): SPEC "pause/resume" — NO resume route exists; resume =
  re-set/re-promote (§1). UI Resume re-posts current variants (pause
  cleared server-side). SPEC wording corrected at flip.
- D2 (pause copy): SPEC "manual = actor" — reason is the literal
  `'operator'`; the ACTOR is `paused_by`. Burn reason is
  ``burn_rate: …`` + actor. NULL = legacy. Copy corrected, banner stays
  verbatim.
- D3 (status enum): SPEC/README "rolled back is NOT a version status" —
  `'ROLLED_BACK'` IS in the enum but never written (historical). Rows never
  carry it; no UI branch may expect it. Wording corrected (exists-but-
  unwritten vs absent).
- D4 (delete line): SPEC `service.ts:254` → actual `:274` (message verbatim
  §1). Retire-active 409 copy added (`:836-842`). Rollback-to-DRAFT refused
  (`:877-878`).
- D5 (degraded sweep): SPEC `1708-1773` → fn at `:1717` (comment `:1706`);
  warn-once mark at `:1771-1773`; auto-suspend via `setDisabled`
  (`:1741-1748`).
- D6 (provenance range): SPEC `1100-1148` → actual `1090-1149`
  (`parent_version_id` at `:1148`).
- D7 (audit comment): `org-audit.service.ts:52` "prefix filter" is stale —
  exact match only.
- D8 (trail empty in prod): `AgentTrail` queries `action:'assistant.'`,
  which exact-matches NOTHING — the trail renders empty outside mocked
  tests TODAY. Fixed here (unfiltered newest-100 + client prefix set +
  scope note). This is a live bugfix, filed as the highest-value C15 line.
- D9 (no per-assistant trace/channel reads): operate shows run links and
  per-assistant channel bindings from org reads filtered client-side;
  per-channel metric breakdown is unbuildable (rollup kinds fixed) — stated,
  not faked.
- D10 (provisioning dead-letter): Box-1 "permanently carries
  install/provisioning state" is unbuildable — C11 proved no provisioning
  progress read exists (one TX, no poll/SSE/status). No dead-letter UI;
  stated in non-goals, SPEC box corrected.
- D11 (staff blocks): Box-2 platform read-only rows are unbuildable — the
  template-blocks read is staff-guarded. Library keeps org rows only;
  stated, SPEC box corrected.
- D12 (queues): memory proposals have NO list read; escalations have NO
  console reads. Aggregate is unbuildable; separate destinations stand
  (§9 decision). SPEC box-3 recorded as decided-separate with the
  provability argument.

## 9. Dedicated surface plan (keep-vs-extend verdicts)

- Operate cluster (detail): KEEP `OperatePanel/ObservePanel/AgentTrail`
  files + mounts + order. NEW `OperateHeader` (active-version card +
  draft card + lineage strip + single banner + per-assistant channels +
  cost/usage link + builder re-entry) mounted above `OperatePanel`.
  EXTEND `OperatePanel`: Resume button (re-set current variants, paused
  only), current-pointer read (`useReleasePointer`, read-only line),
  audit cross-link, `BlockModal` expiry → datetime-local + futurity +
  permanent confirm (align to `BlocksView` modal — one pattern), adopt
  `describePausedRollout` (single wording). EXTEND `ObservePanel`: link
  back to operate (deep anchor). EXTEND `AgentTrail`: unfiltered newest-100
  + client prefix set (operate actions §1) + reason/detail rendering from
  known keys + actor names + Refresh button + "view all in Audit" +
  cross-link to Operate. No new routes.
- Approvals `/agent-studio/approvals`: KEEP queue + state filters + extend/
  decide. EXTEND: payload drawer (shared `Drawer` — C13 precedent, never a
  fork) with the full listable context + audit link; history column (actor
  + time; reasons via audit link); run→trace link (per-run reads exist);
  `policyVersion` render; per-row pending (per-row mutation instances);
  poll while PENDING (`refetchInterval` option); loud missing-runId error
  (replaces the silent null). No new filters (server vocabulary is
  `?state=` only — a client search over 200 capped rows is honest; ADD
  lightweight client search — cheap, no invented server param).
- Blocks `/agent-studio/blocks`: KEEP + small EXTEND: `Set by` member-name
  resolution, full timestamps (keep Expires-in-N pill), per-row audit
  hint via Audit link (no per-row event join — unbuildable exactly).
  No staff rows (D11), no per-assistant filter (not demanded).
- Memory/escalations: NO new UI (§8 D12). Decision recorded in SPEC + §2 R6.
- Builder: `?slot=` re-entry only (§3, §6).

## 10. Explicit non-goals

- Incident system (no engine incident reads; burn/auto-rollback surface
  via the widened trail + paused banner only).
- Analytics/anomaly/variant sliders (ledger-locked DEFERRED).
- Auto-advance/scheduled rollouts (no engine concept — stated once).
- Per-channel metric breakdown (rollup kinds fixed — D9).
- Memory-proposal queue (no list read — D12).
- Escalations queue UI (no console reads — D12).
- Provisioning dead-letter UI (no progress read — D10).
- Staff template-block rows (staff-guarded — D11).
- Run-level trace view per assistant (no list endpoint — links target the
  existing per-run reads).
- New shortcuts, new routes, new cache families, second derivations
  (paused wording, readiness, health all single-sourced).

## 11. Query-key + invalidation plan

Reads (single-source, existing keys): `['studio','setup','operate',org,agent]`
(rollout/release/blocks), `['studio','setup','approvals',org,state]`,
`['engine','audit',org,filters]`, channels (`useChannels`), rollups
(`useAnalyticsRollups`), versions/provenance/health (authoring). Writes keep
existing invalidations (operate-key, approvals-key); decide/extend keep
toast-on-untyped-error (typed conflicts — e.g. extend-non-pending 409 —
surface inline in the queue, never toasted-away). Audit reads stay
unfiltered-newest-100 per trail instance (documented scope, never claimed
complete).

## 12. Shortcut impact

NONE. No new shortcut; no moved shortcut; the C09 lock test untouched.
`?slot=` is pointer/navigation state, not a key binding.
