# Neryva Release Gap Report — Template Plane to Working Product

| Field | Value |
|---|---|
| Status | **FINAL (2026-09-13)** — gap register re-verified against code; safe closures applied during finalization (§5 GAP-12, §10 REL-1/3/4/6); remaining items are decision- or run-gated, not unknown |
| Date | 2026-09-13 (finalized same day; finalization pass listed in §11) |
| Scope | Everything standing between the current codebase and a releasable, working, sellable product for organization-built agents — code, execution path, release engineering, operations, and legal/commercial surface |
| Authority | `../_agent_setup_detail_plan.md` (design), `../agent_setup_ledger.md` (execution order), `docs/architecture/engine/imp/ledger.md` (phase gates), `ops/slo.md` + `ops/runbooks/` (operational bar) |
| Method | Role-based end-to-end flow simulation against the actual code (every blocking claim cites `file:line`); static verification only — no database was reachable, so DB-backed gates remain unexecuted and are tracked separately, not re-litigated here. Finalization pass added a full ledger/tooling/ops sweep (§10–§11) and re-verified each GAP evidence citation against the current tree |

> **Reading guide for management:** §2 is the one-page summary. §5 is the binding gap register
> (every item has severity, evidence, impact, and dependency). §6 answers the provider-key
> question with a decision and design. §7 proposes the release sequencing. §10 is the
> release-engineering register (CI/CD, ops, docs) and §12 the legal/commercial register.
> Items marked **(verify in DB session)** are credible risks I could not confirm statically and
> must not be treated as facts until the first full run.

---

## 1. Current state (what is genuinely done)

The governance plane for organization agents is substantially built and statically clean
(`typecheck` / `build` / `lint` green; dist boot resolves the full DI graph and maps 220+
routes with zero conflicts):

- Global template registry + release-job sync (`drizzle/0048`, `src/scripts/sync-template-registry*`,
  tamper refusal proven) and 20 lint-passing agent BOMs (`products/agent-studio/templates/`).
- Atomic install-as-copy + outbox-driven provisioning (tool pins, knowledge seeds, eval seeding).
- Publish pipeline with immutable snapshots, tool bindings, knowledge pins, model refs,
  manifest hashes, run manifests, release pointers with canary weights, five-level kill
  switches, eval decisions with provenance, candidate promotion loop, channel bindings.
- Conversation plane (messages, runs, events, SSE, shares, export, feedback, titles),
  escalation queue, human approval decision endpoint, widget + WhatsApp/Messenger/Telegram
  surfaces, knowledge upload/ingestion/retrieval, memory proposals/decisions, usage ledger
  writes on terminal commit, entitlements/trials, Stripe rail, invoices, retention/legal-hold/
  purge machinery, staff overview/impersonation/audit.
- Release engineering that exists and is sound: strict zod env contract with production
  fail-closed boot gates (`src/common/config/env.ts`), single release-job migration runner
  with journal verification (`ops/migrate.sh`), dev compose stack (`ops/docker-compose.yml`),
  production compose lane + non-root Dockerfile + Caddy edge proxy (`ops/engine/`),
  3 Grafana dashboards (`ops/dashboards/`, Phase 1.7 skeletons), SLO table (`ops/slo.md`),
  7/7 on-call runbooks (`ops/runbooks/` — 5 authored during finalization), an authored
  12-step e2e exit gate (`ops/e2e/h1a-exit-gate.mjs` + fixtures), and a CI workflow
  (`.github/workflows/ci.yml`) covering typecheck/lint/unit + migration smoke — repaired
  during finalization (§10 REL-1..4; it could not previously complete an install).

**What this means:** Neryva can govern an agent's entire lifecycle on paper. What it cannot do
yet is *run* one for money. Every gap in §5 traces back to that sentence.

---

## 2. Executive summary

1. **No model provider key exists anywhere in the system.** No store, no endpoints, no seed,
   no delivery to the runtime. In production every real model call throws
   `PROVIDER_CREDENTIAL_MISSING`. This is the root gap; six other gaps are its consequences.
2. **Nothing can execute.** Runs park in `ACCEPTED` forever; `eval.run_requested` has no
   consumer, so no evaluation ever completes and no decision is ever recorded.
3. **The publish gate is vacuous.** It blocks only on a recorded `BLOCK` decision, and
   `release_policy.yaml`'s required checks are never read by the publish path — so with no
   executor, *everything* is publishable and the "governed release" story does not hold.
4. **Money is metered but not enforced or priced.** Quota service has zero callers on the
   conversation path; per-model cost is defaulted to zero.
5. **Humans are out of the loop operationally.** No test-conversation path (must publish to
   prod to see behavior), no pending-approval list, no notifications on approvals/escalations.
6. **The platform cannot operate the fleet.** No global template kill, no install-base
   inventory, manual CLI-only template releases.
7. **The release engineering exists but has never executed.** CI could not complete an
   install as written (sibling path dependency, §10 REL-1/2); no DB-backed suite has ever run
   anywhere; the e2e exit gate is authored, not executed; there is no deploy pipeline.

**Recommendation:** a three-wave program (§7) — Wave 1 makes an agent run and cost money
(keys → execution → eval → enforcement → pricing → pre-publish testing); Wave 2 makes it
operable (notifications, fleet controls, CI/CD gates); Wave 3 is enterprise hardening (BYOK,
advanced policy). Nothing in Wave 1 contradicts the architecture; the Studio gateway was
already designed for sealed credential refs, it just was never fed.

---

## 3. Role-flow simulations

Each flow was walked step by step against the controllers, services, and workers in the tree.
Legend: OK = endpoint + backing logic verified · DEAD = endpoint exists but the downstream
never fires · MISSING = no capability · WEAK = exists but unenforced/unusable.

### 3.1 Superadmin (platform staff)

| Step | Result | Evidence |
|---|---|---|
| Manage staff roles, view orgs/accounts, verify audit chain, impersonate | OK | `staff.controller.ts` — `roles`, `orgs`, `audit/verify`, `impersonate` routes |
| Grant org features, start trials | OK | `POST orgs/:orgId/features`, `POST :orgId/entitlements/:product/trial` |
| Publish a template release | WEAK | Git PR + local lint + manual `templates:sync` CLI only; no management API, no release audit beyond `template.registry_synced` |
| Revoke a dangerous template platform-wide | MISSING | `control-blocks` are org-scoped (`control-blocks.controller.ts`, owner/admin roles); registry `status` changes only via file sync |
| See which orgs run `slug@version` (blast radius) | MISSING | No install-base inventory endpoint; data exists (`assistant_installs`) but is not queryable cross-org |
| Manage provider keys / model availability globally | MISSING | No such store exists at any scope (§5, GAP-01) |

### 3.2 Organization admin (the money flow: "set up my agent")

| Step | Result | Evidence |
|---|---|---|
| Create org, invite members, redeem invites, start trial | OK | `org.controller.ts` — `POST`, `invites/:inviteId/redeem`, trial route |
| Browse templates with compatibility reasons | OK | `templates.controller.ts` + `templates.service.ts:90-148` |
| Install template → DRAFT + provisioning | OK | `assistants.service.ts` create path; `template-provisioning.consumer.ts` |
| Choose provider/model for the agent | **DEAD** | `allowed_models` accepted (`dto.ts:50`) and validated against `model_catalog` (`assistants.service.ts:787`), but catalog entries are bare names with no credentials behind them; see GAP-01–02 |
| Upload knowledge, check seed coverage | OK | `knowledge.controller.ts` uploads/documents; provisioning seed check |
| Curate memory (proposals/decisions/delete) | OK | `knowledge.controller.ts` + `harness-parity.controller.ts` memory routes |
| Connect channels, rotate/verify credentials, caps | OK | `channels.controller.ts` full CRUD + `credentials/rotate`, `verify`, `webhook-setup` |
| Run evaluation on a version | **DEAD** | `POST eval/runs` emits `eval.run_requested` (`eval.service.ts:335`) — **no consumer exists anywhere in `src`** (re-verified in finalization against the full worker/consumer inventory in `src/workers/`) |
| See eval decision / provenance | OK (when data exists) | `versions/:versionId/provenance`, `last_evaluation` on reads |
| Try the agent before publishing | **MISSING** | No test-conversation endpoint (ledger item 3.5 never built) — GAP-07 |
| Publish / canary / rollback / kill | OK (mechanics) | Publish, releases, rollouts, control-blocks, `disabled_at` all wired; **but** gate vacuous — GAP-04 |
| Get notified on approval/escalation; find pending approvals | **MISSING** | Decision endpoint exists (`:runId/approvals/:approvalId/decision`); no list, no notify — GAP-08 |
| Embed on website; support chat ops (claim/assign/resolve/reply) | OK | `widget.controller.ts` (`session`, `messages`, `embed`, `neryva.js`); `escalations.controller.ts` |
| Understand and control spend | WEAK | Ledgers/invoices readable; nothing enforces or prices — GAP-05/06 |

### 3.3 Developer / integrator

API keys (L2), service accounts, shares, conversation export, SSE replay: OK. (OpenAPI
artifact generation/drift gating is cited as a merge gate but its CI enforcement is TODO —
tracked in `agent_setup_ledger.md` TPL-10.5 and §10 REL-8 here.)

### 3.4 End user (the organization's customer)

Widget chat, channel messaging (WhatsApp/Messenger/Telegram), escalation, feedback: OK via
public surfaces. Constraint (by design, must be communicated, not "fixed"): console
conversation APIs require org membership (`OrgRolesGuard` on
`conversations.controller.ts`) — there is no end-user identity on console paths. B2C
integrators must use the widget/channel planes, which is the correct posture but must be
documented as a hard boundary.

### 3.5 Evaluator / QA

Datasets, cases, runs, results, candidate promote/reject, recall, rollups: OK as APIs —
**DEAD** as a loop, because case execution needs a model (GAP-03) and the LLM-judge consumer
requires an externally configured judge URL. Golden fixtures and CI gates: TODO (TPL-5.7,
TPL-10; §10 REL-9).

### 3.6 Billing / finance

Entitlements, trials, Stripe checkout + webhook inbox, invoices, spend ingest, usage ledger,
reconciliation: OK as machinery. **Not connected to inference economics**: no quota
enforcement (GAP-05), no per-model pricing (GAP-06). Current state bills nothing for AI
usage and prevents nothing.

---

## 4. What is NOT missing (do not re-work)

Registry/sync, install-as-copy, provisioning checks, snapshot/manifest provenance, release
pointers + canary, kill switches at five levels, RBAC mapping, channel plane, widget,
escalations queue mechanics, knowledge pipeline, memory governance, usage-ledger mechanics,
entitlements/trials, Stripe rail, lifecycle (retention/holds/export/purge), staff tooling.
These need their DB-backed gates executed (TPL-10, §10 REL-3/REL-12), not redesign.

---

## 5. Gap register (binding)

Severity: **P0** = product cannot function · **P1** = cannot release safely/sell ·
**P2** = cannot operate at scale. Dependencies form one chain: GAP-01 → GAP-02 → GAP-03 →
(GAP-04 meaningful, GAP-05/06 billable); GAP-07/08/09/10 parallelizable once GAP-01 lands.
Re-verified 2026-09-13 during finalization: every citation below was re-checked against the
current tree and holds.

### P0 — the product does not run

**GAP-01 — No provider credential store (any scope).**
Evidence: repo-wide search for `provider_credential|providerCredential|byok|provider_api_key`
returns zero stores/endpoints; only two forward-looking comments
(`knowledge/ingestion.service.ts:314`, `config-publish/payload-schemas.ts:156`).
Impact: there is nowhere to put a model key, so every "supported model" is a string with no
key behind it. Blocks GAP-02/03/05/06.
Fix: new Engine-owned `provider_credentials` table (org scope, RLS `ENABLE + FORCE`,
envelope-sealed material following the channel-credential `enc:v1:` precedent — never raw
keys in rows), CRUD + rotation endpoints (owner/admin), audit on every access. Keys are
per-org, per-provider (see §6 for why not per-agent).

**GAP-02 — No credential delivery to the runtime.**
Evidence: `StartRun` carries IDs + capability token only
(`transport/mcp/runtime-control.client.ts:68-76`); Studio's gateway resolves per-call
credentials via `credentialRefs + secretProvider`
(`products/agent-studio/packages/model-gateway/src/model-gateway.ts:82-91`) but no Studio
app constructs it with real refs and `runtime-worker/config.ts` defines no provider-key
source. Production outcome today: `PROVIDER_CREDENTIAL_MISSING` on every real call.
Impact: Engine and Studio agree on the credential protocol but neither side feeds it.
Fix: Engine mints short-lived, run-scoped sealed credential refs next to the capability
token (resolvable via `GetAuthorizedRunContext` or `StartRun` extension — contract
additive, v1-compatible); Studio implements the `SecretProvider` against Engine refs.
Raw keys never touch logs, traces, Temporal history, or frontend events (invariant 9).

**GAP-03 — No eval executor (`eval.run_requested` has no consumer).**
Evidence: `eval.service.ts:335` emits; exhaustive search of `src/**/*.consumer.ts` and
event-type subscriptions shows zero subscribers; eval runs therefore never leave their
initial state and no `decision` is ever written.
Impact: the entire TPL-7 gate chain (decisions → BLOCK enforcement → provenance →
regression → observe loop) is inert. Combined with GAP-04, "governed release" is a claim
without a mechanism.
Fix: consumer executing cases through the Studio runtime (depends on GAP-01/02), writing
`decision + release_policy_version + provenance` on completion; or, as an interim,
a documented Engine-side harness executor for text-only cases. Either way, the loop must
close before any release claim is made.

**GAP-04 — Publish gate does not enforce release policy.**
Evidence: `assistants.service.ts:962-981` blocks only on a recorded `BLOCK` decision;
`required_checks|release_policy` has **zero references** in the publish path (finalization
re-check: `release_policy` exists as a stored jsonb column, `assistants/schema.ts:251`, but
nothing reads it) — the `release_policy.yaml` required checks, critical failures, and
regression thresholds are never read. With GAP-03 unexecuted, no `BLOCK` can ever exist, so
every payload is publishable.
Impact: the headline safety property ("critical failures are mathematically
unpublishable") is true but vacuous; unevaluated content publishes silently.
Fix (decision required, §6.4): either (a) enforce `required_checks` — publish requires a
fresh `PASS` on the content hash — or (b) formally downgrade eval to advisory and say so
in the plan and UX. Shipping the current ambiguity under a "governance" banner is the
worst option.

### P1 — cannot sell or safely operate the release

**GAP-05 — Quota enforcement is unwired.**
Evidence: `quota.service.ts` exposes `checkAndReserve`/`release`; finalization re-check
confirms callers exist only on the deployment/metering/console paths
(`billing.worker.ts`, `metering.controller.ts`, `console-platform.controller.ts`,
`deployment*.ts`) — **zero call sites on the conversation/run path**. Usage is recorded
post-hoc (`conversations.service.ts:1120-1137`, `usage-ledger.consumer.ts`) but nothing
reserves, rejects, or degrades on the agent path.
Impact: unbounded inference spend per org; trial limits and plan limits are display-only
on the agent path; one abusive tenant can consume the shared platform key pool (once
GAP-01 exists).
Fix: reserve on message acceptance (same TX as run creation), commit/release on terminal
states, typed 402/429 with retry guidance; per-dimension limits surfaced from entitlements.

**GAP-06 — No per-model cost pricing.**
Evidence: Studio prices at zero by default (`MODEL_GATEWAY__COST_MICROS_PER_1K_TOKENS`
default 0); Engine's commit-time entry records token counts without cost
(`conversations.service.ts:1129-1137`).
Impact: invoices cannot reflect AI cost; margins are unknowable; GAP-05's budgets have no
monetary leg (`max_cost_micros` is passed to Studio but priced at zero).
Fix: platform cost catalog ($/1k tokens per provider/model, versioned, auditable) feeding
both the Studio budget check and the Engine ledger's estimated/settled cost; BYOK
accounting (credits vs passthrough) designed now even if built in Wave 3.

**GAP-07 — No pre-publish test path.**
Evidence: ledger item 3.5 (test-conversation endpoint) was never built; no route matches
it in `assistants.controller.ts` / `conversations.controller.ts`.
Impact: the org's first contact with agent behavior is a production publish — unacceptable
for a governance product and fatal for demos/evals-by-humans.
Fix: test-run endpoint executing a DRAFT version under a test budget with generated data
marked as test data (per the original ledger rule), invisible to end users and excluded
from billing/rollups.

**GAP-08 — Humans are never notified; pending work is undiscoverable.**
Evidence: approval decision endpoint exists
(`conversations.controller.ts` `:runId/approvals/:approvalId/decision`) with no
list-pending endpoint; finalization re-check: zero references to `NotificationsService` in
`conversations/` or `assistants/` modules — `mcp-authority.service.ts` and
`escalations.service.ts` contain no notification calls on creation.
Impact: approvals stall until expiry; escalations sit unclaimed; SLAs (where promised)
cannot be met; the handoff story fails its first real incident.
Fix: pending-approval/escalation list endpoints + notification fan-out on creation
(using the existing notifications module + webhook/outbox machinery), with expiry and
re-assignment semantics.

**GAP-09 — Model catalog is hand-authored and unchecked against reality.**
Evidence: orgs publish `model_catalog` JSON by hand (`config-publish` draft flow); nothing
seeds it, and compatibility checking cannot distinguish "unknown model" from "known model
with no key for this org" (`templates.service.ts:340-397`).
Impact: misconfiguration is the default path; every install starts with a JSON-writing
exercise; support load on day one.
Fix: platform-seeded catalog + per-org availability view (catalog ∩ enabled providers ∩
present credentials ∩ entitlement), wired into list/install compatibility reasons.

### P2 — operate the fleet

**GAP-10 — No fleet-level safety controls.**
Evidence: control blocks org-scoped only; no cross-org install inventory endpoint although
`assistant_installs` holds the data; template release is manual CLI.
Impact: a poisoned/misbehaving template cannot be stopped platform-wide; blast radius is
unmeasurable; releases are un-auditable operations chores.
Fix: platform template kill (registry status with immediate effect + audit), install-base
inventory (staff roles), release-job observability (or a minimal management API).

**GAP-11 — Exit-gate backlog (already tracked, restated for completeness).**
`agent_setup_ledger.md` TPL-3.4 (lint in CI), TPL-5.7 (golden manifest fixture), TPL-10.1–
10.5 (isolation, round-trip, red-team scenarios, concurrency gates, OpenAPI drift + doc
reconciliation). CI now has the machinery to execute the DB-backed suites (§10 REL-3) —
the remaining work is running them green and wiring the template gates (REL-9).

**GAP-12 — Dead code / hygiene. — CLOSED 2026-09-13.**
`UsageLedgerService` was injected into `mcp-authority.service.ts` but never called (the
real write lives in `conversations.service.ts:1121`). **Finalization pass removed the dead
import + constructor injection**; typecheck/lint green. (Recorded here because dead wiring
in authority code erodes trust — it misled one review already.)

### Needs-verification in the DB session (not asserted as gaps)

- Voice channel depth (`channels/voice.service.ts` exists; real-time behavior unassessed).
- Long-context/retrieval quality behaviour under real data (policies verified, recall not).
- Migration 0048/0049 apply order, RLS negatives, backfill behaviour — covered by TPL-10
  when infrastructure exists.

---

## 6. Provider-key decision

### 6.1 The question

For each agent, who supplies the model provider (and whose key pays): the organization
brings its own key (BYOK), or Neryva provides models under its own accounts and the org
just selects?

### 6.2 Evidence constraining the decision

- Architecture assigns credentials to the Model Gateway and allowlists + usage truth to the
  Engine; secrets must never land in Engine rows, logs, or traces.
- Per-assistant `allowed_models` selection already exists — the *selection* granularity is
  solved; only the *credential* granularity is open.
- Billing attributes usage run → assistant → org, so cost accountability is already
  per-org. Per-agent keys would add secret sprawl with zero billing benefit.

### 6.3 Decision (recommended)

**V1 (this release): platform-provided keys. V2 (enterprise): BYOK on the same plumbing.
Keys are per-org/per-provider; model choice is per-agent.**

- The org enables providers (Neryva account under the hood in V1; org-supplied key sealed
  in the GAP-01 store in V2) and each assistant picks models from the enabled set. "Different
  provider per agent" works with one credential design, no per-agent secrets.
- V1 maximizes trial→paid conversion (no key friction) and keeps margin control in the
  cost catalog (GAP-06). V2 answers enterprise procurement/security requirements and
  relieves margin pressure at scale. Designing the sealed-ref delivery (GAP-02) once serves
  both — V2 changes only the key source, not the protocol.

### 6.4 Policy decisions required alongside (management calls)

1. **Eval posture (GAP-04):** enforce `required_checks` (publish needs fresh PASS) or
   formally advisory? Recommendation: enforce for production pointers, allow WARN with
   recorded approver for canary — matches the canary machinery already built.
2. **Trial abuse posture (GAP-05):** hard quota walls or degrade-to-cheaper-model? Needs
   the cost catalog first.
3. **BYOK pricing (V2):** platform fee vs passthrough — affects GAP-06 schema design now.

---

## 7. Proposed release sequencing

**Wave 0 — "The machinery runs" (§10 REL items, no product code):**
REL-2 (CI can install: set `NERVVA_MCP_CONTRACT_REPO` or publish the contract) → REL-3/4
(first CI/DB run evidence via the new advisory `db-suites` job; flip it to required once
green) → REL-12 (execute `ops/e2e/h1a-exit-gate.mjs` against a compose environment).
Exit: CI is green **and meaningful** — migration smoke real, isolation/integration suites
executed, e2e gate executed. This is the ledgers' "first full CI/DB run" and unlocks every
`CODE_COMPLETE → GATES_PENDING → DONE` transition currently frozen across all ledgers.

**Wave 1 — "It runs and bills" (all P0 + pricing/enforcement):**
GAP-01 → GAP-02 → GAP-03 → GAP-04 decision+enforcement → GAP-05 → GAP-06 → GAP-07.
Exit: an org installs a template, tests it pre-publish, publishes under enforced policy,
serves a real user message on platform keys, and the ledger→invoice path prices it with
quotas enforced. This is the first honest "working product."

**Wave 2 — "It operates" (P1 remainder + P2):** GAP-08 → GAP-09 → GAP-10 → GAP-11 (with
the DB session) → REL-5 (CD pipeline) → REL-7 (DR/backup/rotation runbooks + real
dashboards/alerts) → REL-8/9 (OpenAPI drift + template gates in CI).
Exit: humans get notified, misconfiguration is rare, staff can see and stop fleet-wide
issues, CI/CD gates hold.

**Wave 3 — "It enterprises":** BYOK source in the GAP-01 store, residency-aware routing
(the catalog already carries residency — `assistants.service.ts:816-824` — but there is no
second region to route to), auto-rollback on burn-rate (explicitly deferred in TPL-6.2),
advanced approval topologies (approver≠author is recorded opt-in, TPL-6.5).

---

## 8. Risks

1. **Key concentration:** platform keys make Neryva the blast radius for credential leak
   and cost overrun — mitigated by GAP-02 scoping, GAP-05 walls, and rotation runbooks
   (`ops/runbooks/channel-operations.md` + `mcp-capability-incident.md`).
2. **Eval theater:** until GAP-03 executes, every eval-related UI/API implies assurance the
   system cannot provide — consider hiding or badging unevaluated state until Wave 1 closes.
3. **Silent publish:** GAP-04 + GAP-03 together mean "published" currently certifies
   nothing — release notes and UX copy must not overclaim during Wave 1.
4. **Schedule honesty:** Wave 1 is a vertical slice across Engine + Studio + contract +
   ops; it should be planned as its own ledger phase with gates, not squeezed as "leftover
   TPL items."
5. **First-run attrition (Wave 0):** the DB-backed suites have never executed once; expect
   real failures on first CI/DB run. That is the gate working, not a regression — budget
   time for it instead of skipping the run.

---

## 9. Traceability

- Design authority: `../_agent_setup_detail_plan.md`; task order: `../agent_setup_ledger.md`
  (37 CODE_COMPLETE / 7 TODO as of 2026-09-13; statuses unchanged by this report — see §11
  for the full ledger ground truth across all six ledgers).
- Engine gates: `docs/architecture/engine/imp/ledger.md` (Phases 3–10 DB-backed gates still
  pending the first full run — §11 tallies them precisely).
- **Execution order lives in `release_ledger.md`** (same directory): 62 tasks REL-0…REL-11
  admitted from this report's registers — every GAP/REL maps to exactly one task (its
  traceability matrix is the completeness proof); statuses follow the standard
  TODO → CODE_COMPLETE → GATES_PENDING → DONE vocabulary frozen behind the first full
  CI/DB run.

---

## 10. Release-engineering register (finalization sweep, 2026-09-13)

Findings from the tooling/ops/docs sweep that §5 (product gaps) did not cover. Severity as
in §5. Status: **CLOSED** = fixed during finalization; **OPEN** = decision- or run-gated.

**REL-1 — CI install is broken by a Windows-only path specifier. P0. CLOSED.**
`package.json` declared `"@neryva/mcp-contract": "file:..\products\neryva_mcp\neryva-mcp-contract"`
(backslashes). POSIX (CI) cannot resolve that specifier at all — even with the sibling repo
present. **Fixed:** re-specced to `file:../products/neryva_mcp/neryva-mcp-contract` (works on
both platforms); `pnpm-lock.yaml` regenerated and verified.

**REL-2 — CI cannot materialize the sibling contract dependency. P0. PARTIALLY CLOSED.**
Engine CI checks out only the engine repo; the `file:` sibling `../products/neryva_mcp/...`
does not exist there, so `pnpm install --frozen-lockfile` fails in both jobs — **the engine
CI has never been able to complete an install as originally written.** Fixed in the
workflow: a guarded `actions/checkout` of the contract repo (repository variable
`NERVYA_MCP_CONTRACT_REPO`, e.g. `neryva/neryva-mcp`) plus a fail-loud step naming the fix
when the variable is unset; the previously no-op `buf lint` step now targets the checked-out
path (`pnpm --dir ../products/neryva_mcp/neryva-mcp-contract exec buf lint`). **Remaining
decision:** set the repository variable, or (recommended long-term) publish
`@neryva/mcp-contract` to a registry and pin a version — the repo-layout choice also gates
REL-9.

**REL-3 — No DB-backed test has ever run in CI. P1. CLOSED (advisory).**
17 test files exist across 7 vitest lanes (`tests/{unit,integration,isolation,contract}`,
`vitest.*.config.ts`) and none has ever executed; the suites self-skip per-file without a
database. Added a `db-suites` CI job: Postgres (pgvector) + Redis service containers →
`migrate` → `test:integration` + `test:isolation`, marked **advisory** (`continue-on-error`)
until its first green run, then to be flipped to required. This job *is* the "first full
CI/DB run" evidence the ledgers require.

**REL-4 — RLS smoke step silently skipped. P1. CLOSED (as a warning).**
`ci.yml` ran `node scripts/verify-rls.mjs || echo skip` but `scripts/verify-rls.mjs` has
never existed — the migration-smoke job was green while the RLS gate never ran (same
silent-skip failure class as the silent consumer drop fixed in the template-plane review).
Now fails loud with a `::warning::` naming the real gate (`tests/isolation/rls.test.ts` in
the `db-suites` job); authoring the standalone script remains optional.

**REL-5 — No CD / deploy pipeline. P1. OPEN.**
The deploy lane exists (`ops/engine/engine.Dockerfile`, compose + Caddy, compose
`secrets:` for OIDC/MFA keys) and `ops/migrate.sh` is the single release-job migration
runner — but nothing builds/pushes images or deploys on tag/release. The legacy Python
product (`products/neryva_agent_studio` — quarantined Python prototype, NOT the canonical runtime) has a full reference CD (GHCR push, Trivy, SBOM,
staging deploy, monthly DR-drill workflow) to copy the shape from. Also absent: helm/ terraform engine-side (same reference exists).

**REL-6 — Runbook index promised 7, disk had 3. P1. CLOSED.**
`ops/runbooks/README.md` indexes seven runbooks; only outbox-dead-letter, legal-hold-and-purge
and channel-operations existed. **Authored during finalization:** `worker-crash-recovery.md`,
`migration-rollback.md`, `mcp-capability-incident.md`, `cross-tenant-incident.md`,
`billing-webhook-reconciliation.md` (matching the established format; SQL references real
tables/columns only). Rehearsal cadence (Phase 10.12, quarterly) still open.

**REL-7 — Operational tooling gaps vs the SLO doc's own claims. P1. OPEN.**
`ops/slo.md` states "RTO ≤ 1 h (documented in the DR runbook)" — **no DR runbook exists**
(nor backup/PITR-restore or general secret-rotation runbooks; only channel-credential
rotation is covered). Dashboards are self-labelled "Phase 1.7 skeletons"; no
`prometheus.yml`, no alert rules, no status page engine-side (the legacy Python product has
all four as references). Phase 10.9–10.12 drills (PITR/restore, degradation, red-team,
rotation) remain the authoritative open gates.

**REL-8 — OpenAPI drift gate not enforced. P2. OPEN.**
`scripts/export-openapi.ts` exists and plan §7.3 makes OpenAPI drift a merge gate, but no
CI step generates/commits-compares the artifact (TPL-10.5). Recipe: CI job step running the
export with `git diff --exit-code docs/public/openapi.l2.yaml`.

**REL-9 — Template CI gates (TPL-3.4/TPL-5.7) unwired. P2. OPEN.**
`templates:lint` (`products/agent-studio/scripts/neryva-template-lint.ts`) and the golden
manifest fixture gate run only locally; no workflow references them. Blocked on the same
decision as REL-2 (engine CI must be able to check out the products repo, or the products
repo grows its own CI). The lint itself is proven (20/20 templates pass locally).

**REL-10 — Documentation hygiene. P2. OPEN.**
(a) `docs/architecture/engine/imp/ledger.md` "Current %" column (lines 104–115) is stale —
it predates its own per-phase "implementation status (2026-09-01 …)" blockquotes (e.g.
Phase 3 shown 15% while the blockquote records code complete; Phase 4 shown 0% ditto).
(b) The engine-side mirror `docs/architecture/neryva_mcp/ledger.md` shows **0/142 boxes
checked** although the Neryva MCP product is declared complete end-to-end (`AGENTS.md`;
its own repo carries phase0–8 test suites) — the mirror misleads; annotate it as a snapshot
or sync it. (c) A stray empty `docs/New folder/` directory exists (untracked by git;
delete it).

**REL-11 — Legal/commercial surface absent. P1 for public release. OPEN.**
No `LICENSE` file anywhere (`package.json` declares `"license": "UNLICENSED"` — correct for
private source, insufficient for distribution); no Terms of Service, privacy policy, DPA,
pricing page, or status page. The lifecycle module (retention/export/purge/tombstones) is
built and ready to *enforce* whatever the privacy policy promises — the policy itself is
the missing artifact. This is a business deliverable, not code.

**REL-12 — The master gate: nothing has ever run. P0 (meta). OPEN.**
No migration has ever been applied to a real database; no suite has ever executed; the
authored 12-step e2e exit gate (`ops/e2e/h1a-exit-gate.mjs`, FL-1.8) has never run. Every
ledger's terminal state is frozen behind this single event (§11). Wave 0 exists to make it
happen cheaply and honestly.

---

## 11. Ledger ground truth (what "done mostly" means, precisely)

All ledgers gate their terminal state on the same event — the first full CI/DB run — which
has never happened. Current mechanical state:

| Ledger | Format | Current state |
|---|---|---|
| `docs/architecture/engine/imp/ledger.md` | checkboxes | **32 checked / 156 unchecked** (Phases 0–2 task boxes + Phase 2 exit gates checked; Phase 2 is the only phase with checked exit gates). Phases 3–10 declare "code landed … exit gates pending the first full CI/DB run" in per-phase blockquotes. The "Current %" column is stale vs those blockquotes (REL-10a). |
| `docs/dev/auth_ledger.md` | status vocabulary | **14/14 CODE_COMPLETE, 0 DONE** (AUTH-1..5; tally at lines 186–195). |
| `docs/dev/agent_related/agent_setup_ledger.md` | status vocabulary | **37 CODE_COMPLETE / 7 TODO / 0 DONE** (TPL-3.4, TPL-5.7, TPL-10.1–10.5 open; §10 REL-9 covers the two CI-wiring TODOs). |
| `docs/dev/final_ledger.md` (FL) | status vocabulary | **all CODE_COMPLETE**, with documented seams (provider keys = GAP-01/02; judge URL; OAuth apps; runtime dispatch). FL-1.8 e2e gate authored, not executed. |
| `docs/architecture/neryva_mcp/ledger.md` (engine mirror) | checkboxes | **0/142 checked** — stale mirror of the complete product (REL-10b). |
| `docs/architecture/engine/channel_integrations_plan.md` | checkboxes | 8/8 security-invariant boxes unchecked (evidence gates — the code exists; the isolation/idempotency proofs await the DB run). |

Plane boundary status, for scoping "publish":

| Plane | State |
|---|---|
| **Engine** (this repo) | Governance + data plane, ~54k lines, 18 modules, ~432 routes, 49 ordered migrations. Code complete per ledgers; gates pending the first run. |
| **Neryva MCP** (`products/neryva_mcp`) | Contract + implementation, declared 100% end-to-end; 9-proto buf-managed contract, conformance fixtures, 11 phase test files; its own repo, no CI of its own. |
| **Agent runtime** (`products/agent-studio`) | The existing TS execution satellite: 13 packages + 4 apps, template authoring tooling (registry generator + linter, 20 templates), infra (Dockerfiles, k8s manifest, alerts, SLOs), 9 test suites — **but no CI workflow of its own**, and it is where GAP-02's runtime side lands. |
| **Legacy product** (`products/neryva_agent_studio` — quarantined, NOT the runtime) | Separate Python/full-stack prototype with the workspace's only complete release engineering (CD, helm, terraform, DR drills, status page, 9 runbooks). Reference material for REL-5/7 only; canonical runtime is `products/agent-studio/`, canonical contract is `products/neryva_mcp/`; not the plane this report gates. |
| **Agent Studio blueprint** (`docs/architecture/agent_studio/*`) | Design blueprint for the runtime now implemented in `products/agent-studio/`. Publishing does not wait for further runtime work; remaining gates are CI/DB evidence only. |

---

## 12. Finalization changelog (2026-09-13)

This pass verified the draft's every citation against the current tree (all held), then:

1. Swept all six ledgers + plans + ops + CI + product repos (§10, §11) — the draft's scope
   was template-plane product gaps; the release-engineering, legal, and doc-hygiene
   registers were absent and are now binding (REL-1..12).
2. **Closed REL-1** (POSIX-broken `file:` specifier in `package.json` + lockfile regen) —
   the single hardest CI blocker.
3. **Closed REL-2's workflow half** (guarded contract-repo checkout + fail-loud guidance +
   working `buf lint` targeting).
4. **Closed REL-3/REL-4** (advisory `db-suites` CI job; loud RLS-skip warning).
5. **Closed REL-6** (five missing runbooks authored to the established format).
6. **Closed GAP-12** (dead `UsageLedgerService` injection removed from
   `mcp-authority.service.ts`).
7. Re-verified GAP-03/04/05/08 evidence after the template-plane review pass (eval consumer
   absence re-confirmed against the full `src/workers/` inventory; `release_policy` read-path
   absence; quota callers confined to deployment/metering/console; zero notification calls on
   approvals/escalations).

Statuses: **FINAL**. Nothing in this report requires re-litigating the architecture; every
open item is a Wave 0–3 task with a named owner surface, and the single event that unfreezes
all ledgers is the first full CI/DB run (Wave 0).
