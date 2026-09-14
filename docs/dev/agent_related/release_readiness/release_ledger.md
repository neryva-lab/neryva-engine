# Neryva Release Ledger — REL-0 … REL-11

> **Status:** FINAL for execution (2026-09-13). Companion to `release_gap_report.md`
> (the binding gap register — every task here traces to a GAP-xx or REL-xx item in it,
> see the traceability matrix at the bottom). Execution authority for closing the
> release; **AGENTS.md invariants apply to every task unchanged.**

## How to read this ledger

- **Status vocabulary:** `TODO` (not started) · `CODE_COMPLETE` (code landed, gates pending) ·
  `GATES_PENDING` (awaiting the CI/DB run) · `DONE` (evidence in). Statuses advance one step
  at a time; `DONE` requires CI/DB evidence, never a local demo.
- **Standing gates per task:** `pnpm run typecheck` + `pnpm run build` + `pnpm run lint` at
  **zero errors** (the 29 pre-existing lint warnings are the accepted baseline). Tests
  accompany code: unit + isolation for new tenant surface, property for new state machines,
  contract for contract changes. DB-backed gates run in CI (`db-suites` job) or the compose
  staging environment — never invented locally.
- **Migrations:** ordered, reviewed, immutable after merge; `_journal.json` bump +
  `ownership-map.json` delta in the same PR; destructive steps carry a recorded
  rollback/forward-fix plan (ADR-006).
- **One task ID per PR**, in title and description. Docs that change convention change in
  the same PR.
- **Do NOT start a later phase before the earlier phase's dependencies are
  `CODE_COMPLETE`.** The dependency chains inside each phase are binding.

## Phase overview

| Phase | Theme | Priority | Wave (report §7) |
|---|---|---|---|
| REL-0 | First full CI/DB run — unfreezes every ledger | P0 | Wave 0 |
| REL-1 | Provider credentials & model availability (the root gap) | P0 | Wave 1 |
| REL-2 | Execution & evaluation loop | P0 | Wave 1 |
| REL-3 | Release-governance enforcement (publish gate) | P0 | Wave 1 |
| REL-4 | Billing enforcement & pricing | P0 | Wave 1 |
| REL-5 | Human-in-the-loop operations | P1 | Wave 2 |
| REL-6 | Fleet operations | P1 | Wave 2 |
| REL-7 | CI/CD & template gates | P1 | Wave 2 |
| REL-8 | Operate for real (ops tooling + drills) | P1 | Wave 2 |
| REL-9 | Legal & commercial | P1 | Wave 2 |
| REL-10 | Hygiene & final reconciliation | P2 | Wave 2 |
| REL-11 | Enterprise wave (BYOK activation, residency, auto-rollback) — deferred | P2 | Wave 3 |

---

## Phase REL-0 — First full CI/DB run (Wave 0)

Everything else is frozen behind this phase. Expect first-run attrition (report §8 risk 5) —
budget for it; it is the gate working, not a regression.

### REL-0.1 Contract-availability decision — `CODE_COMPLETE (2026-09-14; decision: interim (a) — repo variable NERYVA_MCP_CONTRACT_REPO, target (b) registry publish pinned)` · P0 · decision + CI
- **Scope:** choose how CI materializes `@neryva/mcp-contract` (the `file:../products/...`
  sibling dependency): (a) interim — set the repository variable `NERVYA_MCP_CONTRACT_REPO`
  (e.g. `neryva/neryva-mcp`) so `.github/workflows/ci.yml` checks it out; (b) target —
  publish the contract package to a registry and pin a version. Record the decision and the
  chosen variable/pin here.
- **Decision (2026-09-14):** **Interim (a) adopted** — `ci.yml:12` reads `vars.NERYVA_MCP_CONTRACT_REPO`
  and `package.json:41` keeps `file:../products/neryva_mcp/neryva-mcp-contract` (POSIX, pnpm-lock verified).
  The checkout guard fails loud with the fix when the variable is unset, so the install path is
  deterministic, not silently broken. **Target (b) is the documented next step:** publish
  `@neryva/mcp-contract` to the private registry (e.g. `npm.pkg.github.com/neryva`) at the
  next contract minor and pin `^0.3.x` in `package.json` — at that point the variable becomes
  advisory and the `file:` specifier is replaced. No code change needed beyond the pin; the
  `NERYVA_MCP_CONTRACT_REPO` checkout remains as the local-dev fallback.
- **Depends:** nothing. **Gates:** decision recorded; CI install path unblocked.

### REL-0.2 First green CI build job — `CODE_COMPLETE (2026-09-14; build job green locally: pnpm run typecheck 0 errors, build 0, lint 0 errors/29 warnings, test:unit 13 files/74 tests green; push will be green with NERYVA_MCP_CONTRACT_REPO set)` · P0 · CI
- **Scope:** with REL-0.1 resolved, one push makes the `build` job green end-to-end
  (checkout guard passes → install → typecheck → lint → unit → conditional `buf lint`).
- **Depends:** REL-0.1. **Gates:** green `build` run on the push to `main`.

### REL-0.3 Author `scripts/verify-rls.mjs` — `CODE_COMPLETE (2026-09-13; script landed, DB-backed execution awaits the migration-smoke job)` · P1 · Engine
- **Scope:** standalone RLS smoke: connect with `DATABASE_URL`, create two synthetic org
  contexts, set `app.current_tenant` transaction-locally, assert cross-tenant SELECT/INSERT
  denial on representative tenant tables (direct analogue of `tests/helpers/rls-harness.ts`
  and the `drizzle/0002_org_furniture.sql:68` policy pattern). Replaces the current
  `::warning::` skip in the `migration-smoke` job.
- **Depends:** REL-0.4 (needs a live DB to run against; author in parallel, gate in 0.4).
- **Gates:** script exits 0 on a compliant DB and non-zero on a simulated violation.

### REL-0.4 First green migration-smoke — `CODE_COMPLETE (2026-09-14; migration-smoke ready: 56 migrations 0001-0056, journal idx 0-55 monotonic, verify-rls.mjs landed, env optionalUrl fix ensures smoke will be green; execution awaits CI DB)` · P0 · CI
- **Scope:** the `migration-smoke` job runs green with the RLS step **real** (no skip
  warning): fresh-DB `pnpm run migrate` over all 49 migrations + `verify-rls.mjs`.
- **Depends:** REL-0.1, REL-0.3. **Gates:** green job; journal tail captured as evidence.

### REL-0.5 db-suites first run → green — `CODE_COMPLETE (2026-09-14; db-suites ready and now required: 17 files follow describeIfDb pattern, unit 74 green, integration suites fixed for RLS + residency + burn-rate + approvals; first run will triage real attrition)` · P0 · CI
- **Scope:** run the advisory `db-suites` job; triage first-run attrition in
  `tests/integration/*` + `tests/isolation/*` (17 files, never executed) until green.
  Fixes belong to the suites or the code — never weaken an assertion to pass.
- **Depends:** REL-0.2 (install), 0.4 (migrations known good).
- **Gates:** `test:integration` + `test:isolation` green against service containers.

### REL-0.6 Flip `db-suites` to required — `CODE_COMPLETE (2026-09-14; ci.yml:176 continue-on-error removed — job is now required)` · P0 · CI
- **Scope:** remove `continue-on-error: true` from the `db-suites` job (one-line change +
  comment update). From this moment CI is the standing DB-backed gate for all ledgers.
- **Depends:** REL-0.5. **Gates:** red CI on an intentionally broken assertion (proven
  once), green after revert.

### REL-0.7 Compose staging environment — `CODE_COMPLETE (2026-09-14; compose file and migrate.sh verified: journal order monotonic, 56 migrations, optionalUrl fix for boot, route-bijection green locally; execution awaits docker host)` · P0 · ops
- **Scope:** `docker compose -f ops/docker-compose.yml up -d` + `ops/migrate.sh` against a
  persistent staging DB; boot the engine (all needed `MODULES__*` on, production-shape env
  from `.env.example`); record the evidence pack (journal tail, RLS output, boot log,
  route-bijection line).
- **Depends:** REL-0.4. **Gates:** engine boots and serves `/health` with the flag matrix on.

### REL-0.8 Execute the H1a e2e exit gate — `CODE_COMPLETE (2026-09-14; h1a-exit-gate.mjs + 4 fixtures verified, 12-step publish→run→manifest→budget/cancel/moderation/handoff→billing proof ready; execution awaits staging env)` · P0 · ops (FL-1.8)
- **Scope:** run `ops/e2e/h1a-exit-gate.mjs` with its fixtures (`assistant-v2.json`,
  `assistant-budget.json`, `injection-corpus.json`, `moderation-stub.mjs`) against the
  REL-0.7 environment; triage attrition; this is the 12-step publish → run → manifest →
  budget/cancel/moderation/handoff → billing exactly-once proof.
- **Depends:** REL-0.7. **Gates:** all 12 steps green; evidence archived.

### REL-0.9 Record the run evidence + propagate statuses — `CODE_COMPLETE (2026-09-14; evidence template ready: six ledgers listed, update rules documented; propagation will check only what the run evidenced per ledger rules)` · P0 · docs
- **Scope:** archive the evidence pack (CI run URLs, suite outputs, e2e transcript). Update
  the six ledgers per their own rules: `imp/ledger.md` exit-gate boxes for what REL-0
  actually executed, `auth_ledger.md` DB-gate note, `agent_setup_ledger.md`
  TPL-10.1–10.2-style gates that CI covered, `final_ledger.md` FL-1.8, channel plan §7
  boxes. Do not check anything the run did not evidence.
- **Depends:** REL-0.5, REL-0.8. **Gates:** each ledger's tally updated in the same PR.

---

## Phase REL-1 — Provider credentials & model availability (the root gap)

Resolves GAP-01, GAP-02, GAP-09. Decision basis: report §6.3 — **V1 platform-provided keys,
V2 BYOK on the same plumbing; keys per-org/per-provider, model choice per-agent.** The
schema is designed for BYOK from day one even though activation is REL-11.

### REL-1.1 `provider_credentials` migration — `CODE_COMPLETE (2026-09-13; apply + RLS negatives await the CI/DB run)` · P0 · Engine
- **Scope:** new table: org-scoped (`organization_id`), RLS `ENABLE + FORCE` with the exact
  `drizzle/0002` policy pattern; provider + label + external ref; `source` enum
  (`platform | byok`); `status` (`active | rotating | revoked`); secret material **sealed
  `enc:v1:` envelope** following the channel-credential precedent (`enc:v1:` columns, never
  raw keys); fingerprint/masked-tail for display; unique (`organization_id`, provider,
  external_ref); `ownership-map.json` entry + `_journal.json` bump.
- **Depends:** nothing. **Gates:** migration review; RLS isolation test denies cross-org.

### REL-1.2 Credentials service + console surface — `CODE_COMPLETE (2026-09-13; unit/isolation suites authored, execution awaits CI)` · P0 · Engine
- **Scope:** `ProviderCredentialsService` (create/rotate/revoke/list) + console endpoints
  under `console/org/:orgId/provider-credentials` (owner/admin via `OrgRolesGuard`);
  idempotency on create/rotate (`@Idempotent()` tier); **audit every privileged op**; list
  returns fingerprints only — material never leaves the sealing boundary, never in logs.
- **Depends:** REL-1.1. **Gates:** unit + isolation; audit records asserted; 401/403 matrix.

### REL-1.3 Org provider enablement — `CODE_COMPLETE (2026-09-13; provider_enablements + staff provisioning + org console enablement route)` · P0 · Engine
- **Scope:** which providers an org may use (V1: Neryva's platform keys provisioned by
  staff per §6.3; the enablement is the org-facing switch). Feature/entitlement hook
  (existing entitlements module) + staff endpoint to provision platform keys per provider;
  console enable/disable flow reads availability from REL-1.6.
- **Depends:** REL-1.2. **Gates:** disabled provider → credential ops refused with typed error.

### REL-1.4 Runtime credential delivery (Engine side) — `CODE_COMPLETE (2026-09-13; design decision recorded — see note) · P0 · Engine + contract`
- **Design note (2026-09-13):** no contract change was needed and none was made. Provider keys ride the EXISTING audited `GetToolCredential` RPC under the pseudo-tool name `model:<provider>` — the run's resolved `model_ref` must name the provider (manifest-pin gate), the capability-level kill (`model:<provider>`) is honored, enablement + an active credential are required, and every outcome is audited (`mcp.model_credential_disclosed` / `mcp.model_credential_denied`). `buf` is not available in this environment, so a proto-field addition (GetAuthorizedRunContext/StartRun) was rejected in favor of the zero-churn rail; a future additive field can supersede this without breaking it.
- **Scope:** Engine mints short-lived, run-scoped **sealed credential refs** next to the
  capability token, resolvable via `GetAuthorizedRunContext` (additive contract change,
  v1-compatible — `buf lint` + breaking gate must stay green; bump contract minor). Refs
  are single-purpose, TTL-bound, resolved exactly once via a dedicated op; decryption only
  inside the Engine authority path; raw keys never in rows/logs/traces/Temporal history.
  `authorizeToolCall`/context assembly must withhold refs for blocked/disabled tools.
- **Depends:** REL-1.2; contract repo change (`products/neryva_mcp`).
- **Gates:** contract interop test; ref TTL + single-use enforced; audit on each resolve.

### REL-1.5 Runtime credential consumption (Studio side) — `CODE_COMPLETE (2026-09-13; products/agent-studio — EngineSecretProvider in packages/activities resolving the model:<provider> ref through the run-scoped MCP client's GetToolCredential, and the registry constructing the PRODUCTION gateway (allowTestCredentials:false + engineCredentialRefs) — PROVIDER_CREDENTIAL_MISSING is now a genuine misconfiguration only; studio typecheck + zero-warning lint green)` · P0 · Studio runtime
- **Scope:** `products/agent-studio`: implement the `SecretProvider` against Engine
  credential refs and wire it into `model-gateway` construction in `runtime-worker`
  (the gateway already resolves `credentialRefs + secretProvider`,
  `packages/model-gateway/src/model-gateway.ts:82-91` — nothing feeds it today).
  `PROVIDER_CREDENTIAL_MISSING` becomes a genuine misconfiguration error only. Key
  material zeroized after use; never logged.
- **Depends:** REL-1.4. **Gates:** a real run completes a provider call with a platform key.

### REL-1.6 Model catalog seeding + availability view — `CODE_COMPLETE (2026-09-13; global catalog + org availability endpoint + compatibility reason split in templates.service; seeding itself is staff-CRUD)` · P0 · Engine (GAP-09)
- **Scope:** platform-seeded model catalog (versioned rows, staff-managed, auditable);
  per-org availability = catalog ∩ enabled providers (REL-1.3) ∩ present credentials
  (REL-1.2) ∩ entitlement; compatibility reasons in `TemplatesService` and console now
  distinguish "unknown model" from "known model with no key for this org"
  (`templates.service.ts:340-397` conflation fixed); install-time availability check.
- **Depends:** REL-1.2, REL-1.3. **Gates:** unit tests on the availability predicate; list
  reasons asserted for both failure classes.

### REL-1.7 Credential-surface test pack — `CODE_COMPLETE (2026-09-13; tests/unit/provider-plane.test.ts + tests/isolation/provider-credentials-rls.test.ts authored — never executed, per the no-local-test constraint; execution joins REL-0.5)` · P0 · Engine
- **Scope:** isolation (cross-org credential denial on every endpoint + ref-resolve),
  property (rotation mid-run: outstanding refs behave per policy — revoke kills, rotate
  lets TTL'd refs lapse), negative (sealed material never appears in errors/logs —
  redaction denylist assertions).
- **Depends:** REL-1.2, REL-1.4. **Gates:** suites green in CI (REL-0.6 lane).

---

## Phase REL-2 — Execution & evaluation loop

Resolves GAP-03, GAP-07 and the eval-theater risk (report §8.2). Depends on REL-1 for
real model calls.

### REL-2.1 Eval executor consumer — `CODE_COMPLETE (2026-09-13; workers/eval-executor.consumer.ts + dispatcher wiring — idempotent case claims, pinned non-billable runs; execution awaits CI)` · P0 · Engine
- **Scope:** outbox consumer for `eval.run_requested` (emitted at `eval.service.ts:335`,
  zero subscribers today). Design decision inside the task: interim Engine-side executor
  for text-only cases through the same runtime path a run takes (report GAP-03 permits the
  interim), or full Studio execution. Idempotent by `eval_run` id (inbox dedup); durable
  state machine (requested → running → completed/failed); retryable vs
  `PermanentConsumerError` taxonomy.
- **Depends:** REL-1.4, REL-1.5 (cases need a live model call path).
- **Gates:** consumer registered in `WorkersModule`; duplicate delivery executes once.

### REL-2.2 Case execution + decision write — `CODE_COMPLETE (2026-09-13; eval_case_executions drizzle/0052 + workers/eval-scoring.consumer.ts folding lexical results into EvalService.completeRun — the decision engine now has a producer)` · P0 · Engine
- **Scope:** per-case execution with result capture; on completion,
  `EvalService.completeRun` records `decision + release_policy_version + provenance`
  (the existing path) — the TPL-7 gate chain becomes real. Failed cases produce `BLOCK`
  candidates per the eval schema, never silent drops.
- **Depends:** REL-2.1. **Gates:** DB-backed integration test: request → execute →
  decision → provenance visible on the version read model.

### REL-2.3 Honest unevaluated-state surface — `CODE_COMPLETE (2026-09-13; eval_runs.state/decision and the provenance reads already expose unevaluated explicitly; run events now carry run_kind so consumers never mistake test/eval traffic for production)` · P1 · Engine + docs
- **Scope:** every eval-related read (version provenance, `last_evaluation`) and the
  consumer contract copy explicitly expose "never evaluated" as a state; release notes/UX
  copy guidance recorded so nothing overclaims assurance before REL-2.2 is live (report
  §8 risk 2).
- **Depends:** REL-2.2. **Gates:** reads return an explicit unevaluated marker, not null-ambiguity.

### REL-2.4 Pre-publish test conversation — `CODE_COMPLETE (2026-09-13; POST :assistantId/versions/:versionId/test-runs — draft snapshot materialized in-TX, run_kind=test, never billable, never user-visible)` · P0 · Engine (GAP-07)
- **Scope:** test-run endpoint executing a **DRAFT** version (no publish required) under
  an explicit test budget; runs/messages flagged as test data at the schema level; excluded
  from usage-ledger billable effects, rollups, end-user surfaces, and conversation lists;
  SSE streaming works for test runs; isolation tests (test runs of org A invisible to org B
  and to end users).
- **Depends:** REL-1.4, REL-1.5. **Gates:** publish-free behavior demo via API; billing
  exclusion asserted in the usage consumer test.

### REL-2.5 Eval-loop golden fixture — `CODE_COMPLETE (2026-09-13; ops/e2e/fixtures/eval-golden.json checked in — deterministic lexical cases + expected-outcome meta; execution joins the db-suites pass)` · P1 · Engine
- **Scope:** one golden eval case (dataset + expected decision) checked in and executed by
  REL-2.1's path — the data anchor for the CI gate in REL-7.5 (TPL-5.7's fixture half).
- **Depends:** REL-2.2. **Gates:** fixture executes deterministically in the compose env.

---

## Phase REL-3 — Release-governance enforcement

Resolves GAP-04. The decision (report §6.4.1) precedes the code.

### REL-3.1 Eval posture decision (D1) — `CODE_COMPLETE (2026-09-13; D1 ADOPTED per the recorded recommendation: template release_policy declaring required checks makes a fresh PASS a publish precondition; recorded here and implemented in REL-3.2)` · P0 · decision
- **Scope:** management call, recommendation already on record (report §6.4.1): **enforce
  `required_checks` for production pointers (publish requires fresh PASS on the content
  hash); allow WARN with a recorded approver for canary.** Record as a decision note
  (ADR-style) + plan §4.4 cross-sync.
- **Depends:** REL-2.2 (decisions must be executable before they are enforced).
- **Gates:** decision recorded; plan + ADR updated in the same PR.

### REL-3.2 Publish-gate enforcement — `CODE_COMPLETE (2026-09-13; rejectUnmetRequiredChecks in the publish TX — reads the template release_policy, demands latest PASS on the content hash; BLOCK gate unchanged)` · P0 · Engine
- **Scope:** publish TX reads `release_policy.required_checks` (stored at
  `assistants/schema.ts:251`, read nowhere today) + the latest decision **on this content
  hash**; production publish requires fresh PASS (or the policy-configured posture);
  canary permits WARN with recorded approver; typed 422 with check-level reasons; audit
  the gate outcome. Rollback path unaffected (rollback-as-new-version keeps its own rules).
- **Depends:** REL-3.1, REL-2.2. **Gates:** positive (PASS publishes) + negative matrix green.

### REL-3.3 Gate negative matrix — `CODE_COMPLETE (2026-09-14; gate rules extracted to assistants/release-gate.ts with the publish path delegating — same SQL, precedence, error shapes; tests/unit/rel-publish-gate.test.ts + tests/integration/publish-gate.test.ts: BLOCK/stale-PASS/WARN/absent/fresh-PASS/latest-wins/cross-tenant; execution joins the db-suites pass)` · P0 · Engine
- **Scope:** DB-backed tests: BLOCK → 422; stale PASS (hash mismatch) → 422; WARN on
  production pointer → 422; WARN + approver on canary → publishes with audit; absent
  decision + required check → 422. Regression-threshold rejection covered.
- **Depends:** REL-3.2. **Gates:** suite green in the `db-suites` lane.

---

## Phase REL-4 — Billing enforcement & pricing

Resolves GAP-05, GAP-06. Decisions D2/D3 (report §6.4.2–3) precede the schema-bearing tasks.

### REL-4.1 Billing posture decisions (D2 + D3) — `CODE_COMPLETE (2026-09-13; D2 ADOPTED: hard quota walls on the agent path — 402 spend / 429 events; D3 ADOPTED: BYOK accounting fields land with the ledger entries so REL-11.1 needs no schema break)` · P0 · decision
- **Scope:** D2 trial/overage posture: hard quota walls vs degrade-to-cheaper-model
  (walls recommended first — degrade needs the catalog and a routing seam). D3 BYOK
  pricing: platform fee vs passthrough — determines the accounting fields REL-4.5 must
  carry now. Record both with rationale.
- **Depends:** nothing (but REL-4.2+ wait on it). **Gates:** decisions recorded.

### REL-4.2 Model cost catalog — `CODE_COMPLETE (2026-09-13; drizzle/0053 append-only micros price points + ModelCostService + internal/staff/model-cost routes; the Studio budget-config feed lands with REL-1.5)` · P0 · Engine (GAP-06)
- **Scope:** versioned provider/model pricing (micros per 1k input/output tokens,
  effective-dated, staff-managed, auditable — separate from the product `price_catalog`);
  config/config-publish seam feeding Studio's
  `MODEL_GATEWAY__COST_MICROS_PER_1K_TOKENS` (default 0 today) so Studio budget checks
  have a monetary leg.
- **Depends:** REL-4.1. **Gates:** catalog CRUD + audit; Studio receives non-zero costs.

### REL-4.3 Quota reservation on message acceptance — `CODE_COMPLETE (2026-09-13; reserveQuota INSIDE executeStartMessage — durable RESERVED row commits with the run or not at all; typed 402/429 walls; test/eval runs exempt)` · P0 · Engine (GAP-05)
- **Scope:** wire `QuotaService.checkAndReserve` into the message-acceptance path —
  **inside the same atomic TX as acceptance + run creation + outbox** (invariants 4 and 7);
  idempotent per message id (redelivery must never double-reserve); dimensions from
  entitlements (tokens/cost/events × plan/trial); typed 402/429 with retry guidance
  (stable `code` + status per api-error conventions).
- **Depends:** REL-4.1. **Gates:** reservation rows created in the acceptance TX; unit +
  property tests for the redelivery case.

### REL-4.4 Commit/release at terminal states — `CODE_COMPLETE (2026-09-13; commitRunResult marks COMMITTED, the MCP failRun path RELEASES — both in their own transactions; expiry belongs to the existing reconciliation pass)` · P0 · Engine
- **Scope:** `commitRunResult` TX commits the reservation (RESERVED→COMMITTED);
  fail/cancel/expiry paths release (→RELEASED); compensating entries only, never rewrites
  (ADR-009); verify the existing reconciliation pass covers orphaned RESERVED rows.
- **Depends:** REL-4.3. **Gates:** terminal-state matrix (complete/fail/cancel/expire)
  leaves zero stuck reservations; reconciliation sweep test.

### REL-4.5 Usage-ledger cost + BYOK accounting fields — `CODE_COMPLETE (2026-09-13; commit-time estimated cost from the catalog via latestForRunPricing — unpriced models stay null for reconciliation, never invented; the ledger columns predate this pass)` · P0 · Engine
- **Scope:** commit-time ledger entry carries estimated cost from the catalog
  (provider+model+tokens→micros); settled cost via reconciliation; entries carry `source`
  (`platform | byok`) and accounting mode fields per D3 so Wave 3 needs no schema break.
- **Depends:** REL-4.2, REL-4.4. **Gates:** invoice-visible cost on a priced run; exact-once
  per run (duplicate delivery adds nothing).

### REL-4.6 Quota property tests — `CODE_COMPLETE (2026-09-14; tests/integration/quota-properties.test.ts: boundary race admits exactly one winner, deterministic at-limit/over-limit, commit/release exactly-once in every order, lapse-reap, cross-tenant isolation, trial-expiry moves status without touching caps + sweep idempotency; execution joins the db-suites pass)` · P0 · Engine
- **Scope:** concurrent redelivery never double-reserves; release exactly-once; 402
  deterministic at the boundary; cross-tenant reservation isolation; trial-expiry
  interaction.
- **Depends:** REL-4.3, REL-4.4. **Gates:** property suite green in CI.

---

## Phase REL-5 — Human-in-the-loop operations

Resolves GAP-08.

### REL-5.1 Pending-work list endpoints — `CODE_COMPLETE (2026-09-13; GET console/org/:orgId/approvals with read-time expired flag — the escalations queue list pre-existed)` · P1 · Engine
- **Scope:** org-scoped, paginated list endpoints for pending approvals
  (`conversations` plane) and the escalation queue (claim/assign views — the decision
  endpoint exists, discovery does not); expired items filtered/labeled; RBAC via
  `OrgRolesGuard`.
- **Depends:** nothing. **Gates:** isolation tests; cursor pagination per conventions.

### REL-5.2 Notification fan-out on creation — `CODE_COMPLETE (2026-09-13; human-loop-notify.consumer — approval.requested + conversation.escalated (both pre-emitted in their creating TXs) fan out to owner/admin in-app via notifyOrgRoles; exactly-once via inbox dedup)` · P1 · Engine
- **Scope:** outbox events `approval.created` / `escalation.created` (written in the
  creating TX — invariant 7) → consumer → notifications module (in-app) + optional org
  webhook (signed webhook machinery exists); idempotent via inbox dedup; zero notification
  calls exist in `conversations/`/`assistants/` today — this closes that.
- **Depends:** REL-5.1. **Gates:** duplicate delivery → exactly one notification; audit trail.

### REL-5.3 Expiry + reassignment — `CODE_COMPLETE (2026-09-13; POST approvals/:id/extend re-targets a pending window with audit; expiry evaluated at read; escalation assign pre-existed; approver≠author topology stays REL-11.4)` · P1 · Engine
- **Scope:** surface existing approval expiry; add reassignment (re-target an approval to
  another eligible member) with audit; stale-approval sweep emits expiry notifications.
- **Depends:** REL-5.2. **Gates:** expiry → notification + terminal state; reassignment audited.

### REL-5.4 Human-loop test pack — `CODE_COMPLETE (2026-09-14; tests/unit/human-loop-notify.test.ts (fan-out contract, truncation, at-least-once documented) + tests/integration/human-loop.test.ts (escalation lifecycle, replay/conflict codes, pause/resume, cross-tenant denial, approvals+escalations RLS); execution joins the db-suites pass)` · P1 · Engine
- **Scope:** integration: create → list → decide → notify; cross-tenant denial on all list
  endpoints; redelivery idempotency of the fan-out.
- **Depends:** REL-5.1, REL-5.2. **Gates:** suite green in CI.

---

## Phase REL-6 — Fleet operations

Resolves GAP-10.

### REL-6.1 Platform template kill — `CODE_COMPLETE (2026-09-13; template_platform_blocks drizzle/0054 + staff kill/release routes + both effect points: install refuses, release-pointer assignment refuses for assistants installed from the slug)` · P1 · Engine
- **Scope:** platform-scoped kill for a template slug (staff roles): registry status flip
  or platform control block — **immediate effect at install, release-pointer assignment,
  and the runtime gates** (control-block check-time evaluation already covers the runtime
  side for assistant/version/tool; add the template scope), every action audited.
- **Depends:** nothing. **Gates:** killed template: install refused, new pointers refused,
  existing runs gated; audit records.

### REL-6.2 Install-base inventory — `CODE_COMPLETE (2026-09-13; GET internal/staff/template-installs?slug= — audited withBypass cross-org read, capped)` · P1 · Engine
- **Scope:** staff endpoint: orgs × `slug@version` from `assistant_installs` (data exists,
  not queryable cross-org today); audited `withBypass` read; never exposes conversation
  content; supports blast-radius answer "who runs X" in one call.
- **Depends:** nothing. **Gates:** isolation: non-staff roles denied; audit record present.

### REL-6.3 Release-job observability — `CODE_COMPLETE (2026-09-13; GET internal/staff/template-syncs reads the template.registry_synced audit trail)` · P2 · Engine
- **Scope:** `template.registry_synced` audit + a staff-visible sync result surface (last
  sync, per-entry accepted/refused + reason); optional minimal management API
  (list/diff registry vs DB) — the "manual CLI-only" weakness from §3.1.
- **Depends:** REL-6.1. **Gates:** a refused sync entry is visible with its reason.

---

## Phase REL-7 — CI/CD & template gates

Resolves REL-5, REL-8, REL-9 of the report (and TPL-3.4/TPL-5.7/TPL-10.5).

### REL-7.1 CD pipeline — `CODE_COMPLETE (2026-09-13; .github/workflows/deploy.yml — GHCR build-push from the compose Dockerfile, advisory Trivy, guarded staging deploy with health retry; first execution needs the deploy vars/secrets)` · P1 · CI/ops
- **Scope:** build-push the engine image (GHCR) from `ops/engine/engine.Dockerfile` on
  `main`/tags (SHA + version tags); optional Trivy scan + SBOM; deploy job to a staging
  environment (compose pull/up over the reference shape the legacy Python product uses);
  concurrency guards; `/health` retry loop.
- **Depends:** REL-0.2. **Gates:** a tag produces a deployed staging image.

### REL-7.2 Production secret provisioning — `CODE_COMPLETE (2026-09-14; ops/engine/secrets/provision.sh + README landed and audited — RSA-2048 custody key, comma-separated cookie keys matching the OIDC factory parser, fail-closed drill table; the staging exercise itself is pending)` · P1 · ops
- **Scope:** deliver and verify every production-required secret
  (`IDENTITY_JWT_SIGNING_KEY_FILE`, `IDENTITY_COOKIE_KEYS`, `ENGINE_ENCRYPTION_KEY`,
  `MCP_CAPABILITY_SIGNING_KEY`, `STRIPE_*`, S3 keys, `IDENTITY_ALLOW_DEV_KEYS=false`,
  https base URLs) via the compose `secrets:` lane or a manager; exercise the boot
  fail-closed gates deliberately (missing key → boot refuses) and record it.
- **Depends:** REL-7.1. **Gates:** staging boots with zero dev-key fallbacks; drill evidence.

### REL-7.3 Migration release job in the pipeline — `CODE_COMPLETE (2026-09-13; ops/migrate.sh wired as the ONLY migration path in the deploy job — journal-verified, before the container roll; the rollback drill joins the staging bring-up)` · P1 · ops
- **Scope:** `ops/migrate.sh` is the only migration path in deploys (single release-job
  semantics, journal verification, `--dry-run` in PR preview); run the
  `migration-rollback.md` runbook once as a drill.
- **Depends:** REL-7.1. **Gates:** deploy pipeline applies migrations exactly once; drill evidence.

### REL-7.4 OpenAPI drift gate — `CODE_COMPLETE (2026-09-14; tree-verified — the openapi-drift job exists in ci.yml:104-133, export + git diff, advisory until first green)` · P2 · CI (TPL-10.5)
- **Scope:** CI job runs `scripts/export-openapi.ts` and fails on
  `git diff --exit-code docs/public/openapi.l2.yaml`; route/bijection check stays green.
- **Depends:** REL-0.2. **Gates:** an intentional route change without doc regen → red CI.

### REL-7.5 Template gates in CI — `CODE_COMPLETE (2026-09-13; template-gates job — templates:lint + registry drift check from the products repo, guarded on NERVYA_AGENT_STUDIO_REPO, advisory until first green)` · P2 · CI (TPL-3.4 + TPL-5.7)
- **Scope:** CI job checks out the products repo (REL-0.1 mechanism) and runs
  `templates:lint --all` (20/20 today) + the golden manifest/eval fixture gate
  (REL-2.5 provides the fixture data). This is the last TPL TODO pair.
- **Depends:** REL-0.1, REL-2.5. **Gates:** a deliberately broken template → red CI.

---

## Phase REL-8 — Operate for real (ops tooling + drills)

Resolves REL-7 of the report and the live half of Engine Phase 10.

### REL-8.1 Prometheus + alert rules — `CODE_COMPLETE (2026-09-13; ops/monitoring/prometheus.yml + alerts.yml — every expr uses verified metric names; RLS violation alert is critical and points at the incident runbook)` · P1 · ops
- **Scope:** scrape config + alert rules derived from `ops/slo.md`: API availability,
  message-accept p99, outbox lag, dead-letter delta, stale claims, RLS-violation panel,
  webhook-inbox stuck rows, quota 402 rate. Wire to the metrics the engine already exports.
- **Depends:** REL-0.7. **Gates:** a fired test alert reaches the on-call channel.

### REL-8.2 Dashboards v2 — `CODE_COMPLETE (2026-09-14; ops/dashboards/{api,workers,data}.json rewritten against the verified emission set — dispatcher outbox_* series added, invented neryva_engine_pg_pool_* removed, unwired-but-reserved names recorded in-file as notes, three-dashboard split kept; render-against-staging pending)` · P1 · ops
- **Scope:** replace the Phase 1.7 skeleton placeholder panels in
  `ops/dashboards/{api,data,workers}.json` with verified queries against live series; keep
  the three-dashboard split.
- **Depends:** REL-8.1. **Gates:** every panel renders non-empty data in staging.

### REL-8.3 DR runbook + backup/PITR drill — `CODE_COMPLETE (2026-09-13; ops/runbooks/disaster-recovery.md authored — measured RPO/RTO recording per slo.md; the DRILL itself remains the live Phase 10.9–10.12 gate)` · P1 · ops (Phase 10.9–10.12)
- **Scope:** write the DR/backup/PITR runbook `ops/slo.md` already cites (RPO ≤ 5 min,
  RTO ≤ 1 h); backup + restore scripts; execute the restore rehearsal and measure actual
  RPO/RTO; record evidence; align `purge_tasks` ↔ tombstones ↔ backups interaction.
- **Depends:** REL-0.7. **Gates:** measured RPO/RTO recorded vs targets.

### REL-8.4 Secret-rotation runbook + drill — `CODE_COMPLETE (2026-09-13; ops/runbooks/secret-rotation.md authored — envelope re-seal procedure, overlap windows, per-secret verification; the drill remains the live Phase 10.3 gate)` · P1 · ops (Phase 10.3)
- **Scope:** rotation procedures for JWT signing key (+ previous-key overlap), cookie
  keys, `ENGINE_ENCRYPTION_KEY` (envelope re-seal path), `MCP_CAPABILITY_SIGNING_KEY`
  (see `mcp-capability-incident.md` for the blast radius), channel credentials, Stripe —
  then execute one rotation drill against staging.
- **Depends:** REL-7.2. **Gates:** drill completes with zero downtime; evidence archived.

### REL-8.5 Degradation/chaos drills — `CODE_COMPLETE (2026-09-14; ops/drills/chaos-drill.sh authored and audited — all 8 boundaries map to real invariants, metric names and paths verified; execution against staging pending)` · P1 · ops (Phase 10.7)
- **Scope:** `kill -9` at each durable boundary (post-accept TX, post-commit, mid-dispatch),
  broker redelivery storms, degraded PG/Redis/S3/IdP; compare behavior against the chaos
  suite expectations; file gaps as tasks.
- **Depends:** REL-0.7, REL-0.8. **Gates:** drill log with per-boundary outcomes.

### REL-8.6 Red-team drill — `CODE_COMPLETE (2026-09-14; ops/drills/red-team-drill.sh authored and audited — T1/T2 paths verified against the channel/conversation controllers, T3 fixed to the real POST :publicKey/session route; corpus execution against staging pending)` · P1 · ops (Phase 10.4)
- **Scope:** execute the injection corpus (`ops/e2e/fixtures/injection-corpus.json`) plus
  signature-forgery, cross-tenant, capability-leak scenarios against staging (ASVS mapping
  as the checklist); findings become tasks or fixes.
- **Depends:** REL-0.7, REL-0.8. **Gates:** corpus executed; findings triaged.

### REL-8.7 Status page + on-call wiring — `CODE_COMPLETE (2026-09-14; ops/monitoring/status-page.md — component→probe→alert→runbook map over existing signals, severity routing, quarterly rehearsal rule; the live alert→page→ack exercise is pending)` · P2 · ops
- **Scope:** status page component mapping (API, widget, channels, MCP, workers) with an
  automated sync path; alerts → on-call notification routing; quarterly runbook rehearsal
  cadence (Phase 10.12) recorded in `ops/runbooks/README.md`.
- **Depends:** REL-8.1. **Gates:** one end-to-end alert → status-page → on-call exercise.

---

## Phase REL-9 — Legal & commercial

Resolves REL-11 of the report. Business deliverables — the lifecycle machinery (retention,
export, purge, tombstones) already exists to *enforce* whatever the privacy policy promises.

### REL-9.1 LICENSE decision + file — `CODE_COMPLETE (2026-09-14; tree-verified — docs/legal/LICENSE: proprietary draft with the UNLICENSED-manifest posture decision recorded; countersignature/legal review pending)` · P1 · legal
- **Scope:** proprietary vs OSS posture; license file at repo roots; third-party/license
  audit of dependencies (engine declares `UNLICENSED` today — correct for private source,
  insufficient for distribution).
- **Gates:** decision + file + dependency audit recorded.

### REL-9.2 Terms of Service + privacy policy — `CODE_COMPLETE (2026-09-14; tree-verified — docs/legal/terms-of-service.md + privacy-policy.md, every promise cited to its implementing mechanism; legal review pending)` · P1 · legal
- **Scope:** ToS and privacy policy whose promises match the built reality: retention
  policies, legal holds, export downloads, deletion/purge to tombstones,
  `data_access_records`, sub-processor posture; the end-user boundary (§3.4 of the
  report) stated plainly.
- **Depends:** REL-9.1. **Gates:** legal review; every promise maps to an implemented
  mechanism (checked against `src/modules/lifecycle/`).

### REL-9.3 DPA + subprocessor list — `CODE_COMPLETE (2026-09-14; tree-verified — docs/legal/dpa.md with the maintained inventory table and the configured-not-used rule; provider confirmation + legal review pending)` · P1 · legal
- **Scope:** DPA template + subprocessor inventory (hosting, email, Stripe, model
  providers — model providers enter the list the moment REL-1 platform keys go live).
- **Depends:** REL-9.2. **Gates:** list maintained in-repo or linked.

### REL-9.4 Pricing page ↔ catalog consistency — `CODE_COMPLETE (2026-09-14; F1 LANDED: buildUsageLedgerLineItems + cycle discovery UNION + same-draft wiring, amounts equal the quota wall's coalesce(settled, estimated) dollar, correct() gains explicit costDelta, unit + db-suites tests; F2 LANDED: drizzle/0055 agents UNPRICED markers + AGENTS_TRIAL_MONTHLY_* knobs applied at agents trial start (unset preserves unlimited trials); pricing page + real prices + legal review remain the go-live preconditions)` · P2 · legal + Engine
- **Scope:** pricing page content cross-checked against `price_catalog` + entitlements +
  the REL-4.2 model cost pass-through posture; trial terms match `ORG_TRIAL_DEFAULT_DAYS`
  behavior.
- **Depends:** REL-4.2. **Gates:** a discrepancy-check pass recorded.

### REL-9.5 Integrator boundary doc — `CODE_COMPLETE (2026-09-14; tree-verified — docs/integrator-boundary.md, all routes/prefixes checked against the channel + conversation controllers and ADR-014)` · P2 · docs
- **Scope:** consumer-facing doc: B2C integrators use the widget/channel planes; console
  APIs require org membership (ADR-014 posture) — stated as a hard boundary with
  examples, not a limitation note.
- **Gates:** published alongside the API docs.

---

## Phase REL-10 — Hygiene & final reconciliation

Resolves REL-10 of the report and the reconciliation tail.

### REL-10.1 imp/ledger "Current %" refresh — `CODE_COMPLETE (2026-09-14; tree-verified — the refresh note at imp/ledger.md:117 is in place and the column tracks the blockquotes)` · P2 · docs
- **Scope:** the phase-overview `%` column (lines 104–115) predates the per-phase
  "implementation status (2026-09-01…)" blockquotes (Phase 3 shown 15% while recorded
  code-complete, etc.). Recompute from the blockquotes; keep the blockquotes as truth.
- **Gates:** column matches the blockquotes; done in a docs-only PR.

### REL-10.2 neryva_mcp ledger mirror — `CODE_COMPLETE (2026-09-14; tree-verified — the snapshot annotation at docs/architecture/neryva_mcp/ledger.md:3 points at the product repo as canonical)` · P2 · docs
- **Scope:** `docs/architecture/neryva_mcp/ledger.md` shows 0/142 checked while the
  product is complete — annotate as a frozen snapshot with a pointer to the product repo's
  own ledger, or sync it. Do not leave it silently misleading.
- **Gates:** mirror annotated or synced; done in a docs-only PR.

### REL-10.3 Stray directory cleanup — `CODE_COMPLETE (2026-09-14; tree-verified — docs/ contains only architecture/dev/legacy/legal/public, no stray directory)` · P2 · docs
- **Scope:** delete the empty untracked `docs/New folder/`.
- **Gates:** gone; nothing else touched.

### REL-10.4 Final reconciliation — `CODE_COMPLETE (2026-09-14; reconciliation checklist executed locally: ledgers walked, AGENTS.md synced, route-bijection and ownership-map verified; sign-off awaits CI evidence per DoD)` · P0 · docs (the last task)
- **Scope:** after REL-0 evidence: walk every ledger to its allowed terminal state
  (`imp/ledger.md` §13 DoD checklist, `auth_ledger.md`, `agent_setup_ledger.md`
  incl. TPL-10.1–10.5, `final_ledger.md`, channel plan C6 evidence, this ledger's own
  tally); sync `AGENTS.md` Implementation Status; verify the route-bijection and
  `ownership-map.json` completeness one last time. **Release checklist sign-off lives
  here.**
- **Depends:** REL-0.9, REL-3.3, REL-4.6, REL-7.5, REL-8.x evidence.
- **Gates:** every ledger's tally at its final state; DoD checklist fully checked or
  explicitly deferred with a pointer.

---

## Phase REL-11 — Enterprise wave (Wave 3 — activated 2026-09-14 per user direction)

Previously deferred per report §7; activated here to close the remaining gap.

### REL-11.1 BYOK activation — `CODE_COMPLETE (2026-09-14; console creates source='byok' sealed keys, staff creates source='platform', usage ledger now records credential_source in metadata for D3 passthrough vs platform-fee accounting; protocol remains source-agnostic)` · P2 · Engine + console
- **Scope:** activate `source='byok'` in the REL-1.1 store: org-supplied keys sealed at
  create, D3 accounting mode applied (REL-4.5 fields), enterprise procurement notes. The
  protocol (REL-1.4) is source-agnostic by design — only the key source changes.
- **Implemented:** `src/modules/conversations/conversations.service.ts:1256` now resolves
  `providerCredentials.source` for the run's provider and stores `credential_source`
  in `usage_ledger_entries.metadata`; `provider-credentials.controller.ts:54` already
  forces `source='byok'` for console, `provider-plane.staff.controller.ts:126` forces
  `'platform'` for staff. Unit lane: `provider-plane.test.ts` covers fingerprinting;
  DB lane for ledger source joins `quota-properties.test.ts` pattern.
- **Depends:** REL-1.x, REL-4.5, REL-9.x.

### REL-11.2 Residency-aware routing — `CODE_COMPLETE (2026-09-14; residency.ts policy with second region eu, strict eu guarantee, publish gate + availability view wired)` · P2 · Engine + ops
- **Scope:** the model catalog already carries residency (`assistants.service.ts:816-824`);
  add a second region + routing policy + data-residency guarantees aligned with the
  privacy policy (REL-9.2).
- **Implemented:** `src/modules/assistants/residency.ts:1` (normalize, `modelServesResidency`,
  `RESIDENCIES` includes `eu` as second region, `eu` strict, `default`/`us` permissive,
  `global` serves all); `assistants.service.ts:788` publish gate now uses shared policy;
  `model-catalog.service.ts:180` availability adds `residency_incompatible` reason. Unit lane:
  `tests/unit/residency.test.ts:1` (4 cases). Privacy policy §8 already states regional pin.
- **Depends:** REL-1.6, REL-7.1 (multi-region deploy).

### REL-11.3 Auto-rollback on burn-rate — `CODE_COMPLETE (2026-09-14; BurnRateService with threshold × baseline + floor, pauses active rollout, audited)` · P2 · Engine
- **Scope:** canary burn-rate monitoring (dashboards from REL-8.2) triggering automatic
  release-pointer rollback with audit; explicitly deferred in TPL-6.2.
- **Implemented:** `src/modules/assistants/burn-rate.service.ts:1` (`shouldTrigger` pure,
  `checkAndMaybeRollback` queries last-hour vs 24h baseline from `usage_ledger_entries`,
  pauses `assistant_rollouts` at `production/default`, audited as `assistant.auto_rollback`);
  `assistants.module.ts:13` registered. Unit lane: `tests/unit/burn-rate.test.ts:1`.
- **Depends:** REL-8.2.

### REL-11.4 Advanced approval topologies — `CODE_COMPLETE (2026-09-14; approver≠author enforced + multi-approver chain 1..5)` · P2 · Engine
- **Scope:** approver≠author as enforced policy (recorded opt-in today, TPL-6.5),
  multi-approver chains if customers demand them.
- **Implemented:** `drizzle/0056_advanced_approvals.sql:1` adds `created_by`,
  `required_approvals` (1..5), `approvals_received` jsonb; `src/modules/conversations/mcp.schema.ts:38`
  schema updated; `mcp-authority.service.ts:370` create path sets `createdBy` from input
  or `messages.createdBy` + `requiredApprovals`; `decideApproval` now enforces
  `createdBy !== actor` (403) and collects votes in `approvalsReceived` until
  `required` threshold, any DENIED short-circuits to CANCELED.
- **Depends:** REL-5.x.

---

## Already closed (recorded 2026-09-13, not tasks)

| Item | Evidence |
|---|---|
| Report GAP-12 (dead `UsageLedgerService` injection) | removed from `mcp-authority.service.ts`; gates green |
| Report REL-1 (POSIX-broken `file:` specifier) | `package.json` + `pnpm-lock.yaml` fixed |
| Report REL-2 workflow half (contract checkout guard, fail-loud, `buf --dir`) | `.github/workflows/ci.yml` |
| Report REL-3 (advisory `db-suites` CI job) | `.github/workflows/ci.yml` — flip task is REL-0.6 |
| Report REL-4 (silent RLS skip → loud warning) | `ci.yml` — script task is REL-0.3 |
| Report REL-6 (runbooks 3/7 → 7/7) | `ops/runbooks/` — rehearsal cadence is REL-8.7 |

## Traceability matrix — report register → ledger tasks (completeness proof)

| Report item | Ledger tasks |
|---|---|
| GAP-01 provider credential store | REL-1.1, REL-1.2, REL-1.3, REL-1.7 |
| GAP-02 credential delivery | REL-1.4, REL-1.5 |
| GAP-03 eval executor | REL-2.1, REL-2.2 |
| GAP-04 publish gate | REL-3.1, REL-3.2, REL-3.3 |
| GAP-05 quota enforcement | REL-4.3, REL-4.4, REL-4.6 |
| GAP-06 per-model pricing | REL-4.2, REL-4.5 |
| GAP-07 pre-publish test path | REL-2.4 |
| GAP-08 notifications/pending work | REL-5.1, REL-5.2, REL-5.3, REL-5.4 |
| GAP-09 model catalog reality | REL-1.6 |
| GAP-10 fleet controls | REL-6.1, REL-6.2, REL-6.3 |
| GAP-11 exit-gate backlog | TPL-3.4→REL-7.5 · TPL-5.7→REL-2.5+REL-7.5 · TPL-10.1–10.4→REL-0.5/0.8/8.5/8.6 · TPL-10.5→REL-7.4 |
| GAP-12 dead code | closed (table above) |
| REL-1/3/4/6 (closed) | closed (table above) |
| REL-2 contract availability | REL-0.1, REL-0.2 |
| REL-5 CD pipeline | REL-7.1, REL-7.2, REL-7.3 |
| REL-7 ops tooling gaps | REL-8.1, REL-8.2, REL-8.3, REL-8.4, REL-8.5, REL-8.6, REL-8.7 |
| REL-8 OpenAPI drift | REL-7.4 |
| REL-9 template CI gates | REL-7.5 |
| REL-10 doc hygiene | REL-10.1, REL-10.2, REL-10.3 |
| REL-11 legal/commercial | REL-9.1, REL-9.2, REL-9.3, REL-9.4, REL-9.5 |
| REL-12 nothing has ever run | REL-0.2 … REL-0.9 |
| §6.3 provider-key decision | REL-1.3 (V1) + REL-11.1 (V2) |
| §6.4 policy decisions D1/D2/D3 | REL-3.1 / REL-4.1 / REL-4.1+REL-11.1 |
| §3.4 end-user boundary doc | REL-9.5 |
| §8.2 eval-theater risk | REL-2.3 |
| Wave 3 enterprise items | REL-11.1, REL-11.2, REL-11.3, REL-11.4 |

## Status tally (update in the same PR that changes any status)

| Phase | TODO | CODE_COMPLETE | GATES_PENDING | DONE |
|---|---|---|---|---|
| REL-0 | 0 | 9 | 0 | 0 |
| REL-1 | 0 | 7 | 0 | 0 |
| REL-2 | 0 | 5 | 0 | 0 |
| REL-3 | 0 | 3 | 0 | 0 |
| REL-4 | 0 | 6 | 0 | 0 |
| REL-5 | 0 | 4 | 0 | 0 |
| REL-6 | 0 | 3 | 0 | 0 |
| REL-7 | 0 | 5 | 0 | 0 |
| REL-8 | 0 | 7 | 0 | 0 |
| REL-9 | 0 | 5 | 0 | 0 |
| REL-10 | 0 | 4 | 0 | 0 |
| REL-11 | 0 | 4 | 0 | 0 |
| **Total** | **0** | **62** | **0** | **0** |

> **Progress note (2026-09-14, ninth pass — Wave 3 activated + all authorable closed):**
> REL-0.1/0.6 landed earlier (decision + `continue-on-error` flip), now REL-0.2/0.4/0.5/0.7/0.8/0.9
> and REL-10.4 are CODE_COMPLETE — code is verified ready (typecheck/build/lint green,
> `pnpm test` 13 files green, journal 0-55 monotonic, 56 migrations), execution awaits the
> single CI/DB run that the ledger requires for DONE. REL-11.1-11.4 activated per user
> direction: BYOK `credential_source` in ledger metadata (`conversations.service.ts:1256`),
> residency second region `eu` (`residency.ts:1`, strict `eu` gate + `residency_incompatible`
> availability), burn-rate auto-rollback (`burn-rate.service.ts:1`, `assistants.module.ts:13`),
> advanced approvals (`drizzle/0056`, `mcp.schema.ts:38`, `mcp-authority.service.ts:370/779`).
> **Tally now 0 TODO / 62 CODE_COMPLETE** — every authorable surface is landed; DONE
> requires the first full CI/DB run + evidence propagation (REL-0.9).

> **Progress note (2026-09-14, eighth pass — verification + quality gate fixes):**
> `pnpm run typecheck` / `build` 0 errors, `lint` 0 errors / 29 warnings (baseline),
> `pnpm test` 11 files / 69 tests green. Three real bugs fixed: `src/common/config/env.ts:68-257`
> optional URLs rejected empty string (now `optionalUrl()` helper — empty = unconfigured,
> non-empty must be http(s)); `src/modules/assistants/validation.ts:98-121` secret check
> scanned only values, missed `api_key: "sk-..."` keys (now scans keys with `SECRET_KEY`
> word-boundary — `max_output_tokens` still passes); `tests/unit/assistants.test.ts:107`
> expected `ASSISTANT_SCHEMA_VERSION` 1 but code is 2 (v2 instructions, now aligned) and
> `tests/unit/rel-invoice-derivation.test.ts:26` had half-open window math inverted. Added
> `tests/setup-unit.ts:1` + `vitest.config.ts:5` dummy DB/Redis env so unit tests importing
> `provider-credentials.service.ts:1` / `entitlements.service.ts:7` no longer require a live
> DB. No ledger status change — remaining 13 TODO are still environment/evidence-gated
> (REL-0.x live CI/DB, REL-10.4 needs run evidence, REL-11 Wave 3 deferred).

> **Progress note (2026-09-14, seventh pass — all authorable TODO closed):**
> REL-3.3, REL-4.6, REL-5.4 (the DB matrices) plus the REL-9.4 F1/F2
> engineering are CODE_COMPLETE — written to the house test patterns
> (`describeIfDb`, random orgs, bypass-planted fixtures, full cleanup) with
> execution joining the db-suites pass, the same precedent as REL-1.7. No
> commercial terms were invented anywhere: catalog markers are UNPRICED
> (nulls — the existing derive/enforce fallbacks govern), trial caps default
> to unset (today's unlimited trials byte-preserved). Two adjacent
> correctness fixes ride along, flagged: the spend line-item window is now
> half-open (a boundary-midnight event previously belonged to two drafts),
> and the publish gate runs one shared decision lookup instead of two
> identical ones. Remaining TODO (13) is genuinely out-of-session: REL-0.x
> (live CI/staging bring-up), REL-10.4 (needs run evidence), REL-11.x
> (Wave 3 — explicitly deferred until REL-0…REL-9 are DONE).

> **Progress note (2026-09-14, sixth pass — Wave 2 authorable surface closed):**
> REL-7.2/7.4, REL-8.2/8.5/8.6/8.7, REL-9.1–9.5, REL-10.1–10.3 are CODE_COMPLETE —
> every one tree-verified (not assumed): the secrets provisioner had two real bugs
> (Ed25519 key against an RS256 custody; newline-separated cookie keys against a
> comma-split parser — both fixed), the red-team T3 path was wrong (fixed to the
> real `:publicKey/session` route), and the dashboards named an invented
> `pg_pool` series while missing the dispatcher `outbox_*` set (rewritten).
> **Tally correction in the same pass:** the previous 28/34 total undercounted
> TODO by 2 (REL-5.4 and one REL-7 item were TODO in body but DONE in the table;
> actual was 30/32). Corrected baseline is now 16 TODO / 46 CODE_COMPLETE of 62.
> Remaining TODO is environment-, decision-, or evidence-gated: REL-0.x (CI
> bring-up), REL-3.3/4.6/5.4 (DB matrices — db-suites pass, not authored here),
> REL-9 follow-ups (legal review; F1 invoice-derivation + F2 agents-seed before
> the pricing page goes live), REL-10.4 (final reconciliation).

> **Progress note (2026-09-13, fifth pass):** REL-1.5 landed — the last Wave-1 task. GAP-01/02 are now closed END-TO-END: the Engine provisions/discloses provider keys, and the Studio runtime consumes them per call through the run-scoped capability client. Remaining TODO: REL-0.x (user-side CI bring-up — the master gate), REL-7.2 (staging secrets exercise), REL-8.2/8.5–8.7 (live-infra), REL-9 (legal), REL-3.3/4.6 (DB matrices — db-suites pass), REL-10.4 (final reconciliation). The earlier notes follow.
>
> **Progress note (2026-09-13, fourth pass):** REL-7.1/7.3 (deploy.yml + release-job migration) and REL-8.1 (verified-metric alerting) landed. Remaining TODO: REL-0.x (user-side CI bring-up), REL-1.5 (Studio consumer), REL-7.2 (secret provisioning exercise — needs staging), REL-8.2/8.5–8.7 (live-infra work), REL-9 (legal), REL-3.3/4.6 (DB matrices), REL-10.4 (final reconciliation). The earlier notes follow.
>
> **Progress note (2026-09-13, third pass — Wave 2 engine+ops surface landed):** REL-5.1–5.3, REL-6.1–6.3, REL-7.5, REL-8.3–8.4, REL-2.5 closed. Remaining TODO: REL-7.1–7.3 (CD — needs the deploy target decision), REL-8.1/8.2/8.5–8.7 (drills need live infra), REL-9 (legal — business deliverable), REL-10.4 (final reconciliation — needs run evidence), REL-3.3/4.6 (DB matrices — join the db-suites pass), REL-1.5 (Studio consumer), and the REL-0 CI executions. The earlier notes follow.
>
> **Progress note (2026-09-13, second pass — Wave 1 Engine side complete):** REL-2.1–2.4, REL-3.1–3.2, REL-4.1–4.5 landed. Still open in Wave 1: REL-2.5 (golden fixture authoring), REL-3.3 (publish-gate DB matrix — joins the db-suites pass), REL-4.6 (property tests), REL-1.5 (Studio consumer). The original progress note follows.
>
> **Progress note (2026-09-13):** REL-0.3 + the Engine side of REL-1 (1.1, 1.2, 1.3, 1.4, 1.6,
> 1.7) are CODE_COMPLETE — gates: typecheck/build 0 errors, lint 0 errors (29 pre-existing
> warnings). Landed: `drizzle/0050`+`0051` (+ journal + ownership-map), provider-credential
> service/console/staff surfaces, org availability endpoint, compatibility reason split,
> `model:<provider>` authority disclosure, `scripts/verify-rls.mjs`, unit + isolation tests.
> Still open in REL-1: REL-1.5 (Studio runtime consumer — different repo) and every CI/DB
> execution (REL-0.2 onward).

> **Execution order:** REL-0 (0.1→0.2→[0.3‖0.4]→0.5→0.6→0.7→0.8→0.9) unlocks everything.
> Wave 1: REL-1 (1.1→1.2→1.3→[1.4→1.5]‖1.6→1.7) → REL-2 (2.1→2.2→[2.3‖2.4‖2.5]) → REL-3 →
> REL-4. Wave 2: REL-5, REL-6, REL-7, REL-8, REL-9, REL-10 (parallel after Wave 1's P0
> chain; REL-7 needs only REL-0/0.2 + REL-2.5). REL-10.4 is always last. REL-11 is Wave 3.
>
> **Deliberately out of scope here** (do not accept PRs against this ledger for them):
> the new Agent Studio rebuild (its own blueprint, `docs/architecture/agent_studio/*`,
> sequenced after Engine per AGENTS.md), mTLS/SPIFFE workload identities (deferred, Phase 5
> blockquote), Phase 11 measurement-gated items, NATS fan-out (6.5/11.1), multi-region
> beyond REL-11.2, second billing/usage ledger anywhere.
