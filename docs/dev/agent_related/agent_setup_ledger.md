# Agent Setup Ledger — template plane implementation tasks

> Execution ledger for `engine/docs/dev/agent_related/_agent_setup_detail_plan.md` (the plan is the
> design authority; this file is the task order). One task ID per PR; reference it in the PR title
> and description. This is a **Phase 3.x expansion** — it does not bypass `imp/ledger.md` gates.

## Rules

- **Statuses:** `TODO → CODE_COMPLETE → GATES_PENDING → DONE`. `CODE_COMPLETE` = code + migration +
  docs merged and `pnpm run typecheck`/`build`/`lint` clean. `DONE` requires the user-authorized
  first full CI/DB run (`compose up + migrate` + integration/isolation suites). Never mark `DONE`
  before that run.
- **Migrations:** ordered, reviewed, immutable after merge, single release job. Next free numbers:
  **0048** (registry) and **0049** (release governance) — journal currently ends at
  `0047_credentials_contract` (47 entries). Every migration ships with a `drizzle/meta/_journal.json`
  bump + `ownership-map.json` delta; destructive steps carry rollback/forward-fix notes.
- **Invariants that bind every task** (plan §0 "Controlling invariants"): runs resolve to immutable
  pinned artifacts; Engine stays system of record; TemplateRelease ≠ AssistantVersion (install is
  copy, registry mutation never mutates a customer assistant). Outbox rows are written in the same
  TX as the fact they announce (invariant 7); every new tenant table gets RLS `ENABLE + FORCE` with
  the `organization_id = current_setting('app.current_tenant', true)::uuid OR bypass` predicate
  (`drizzle/0020_assistants.sql:19-21` shape) + negative tests; no secrets/prompts/credentials in
  rows, logs, or traces (ToolBinding carries sealed-id references only).
- **Out of scope everywhere:** console/UI work (plan §7.3 — consumers adapt to the API after the
  system lands), Engine tenancy/RLS changes, billing math, MCP wire contract changes.

> **Boot readiness (2026-09-13):** the first boot in project history was achieved this session
> (dist boot resolves the full DI graph and maps 220+ routes incl. all template-plane endpoints,
> zero conflicts) after repairing pre-existing breakages (billing exports, consumer/module wiring,
> @Inject tokens, BullMQ queue names, duplicate audit route, body parsers). What remains is
> infrastructure, not code: no PG/Redis on this machine, so migration apply + RLS/isolation suites +
> red-team drills + golden eval/manifest runs await compose/CI. Statuses below stay TODO until then.

---

## TPL-0 — Prerequisites

### TPL-0.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `engine/node_modules/@neryva/mcp-contract` is a stale pnpm snapshot at 0.2.1 while the
  source package is 0.5.0. Run `pnpm install` at repo root; verify the v1.1 types the plan consumes
  resolve (`RunBudgets`, `ToolDescriptor.input_schema_json`, `SearchKnowledge`,
  `SaveConversationSummary`) and `pnpm run typecheck` stays clean.
- **Depends:** nothing. **Gate:** typecheck/build/lint zero errors; installed version == source.

### TPL-0.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** add Phase 3.x rows to `docs/architecture/engine/imp/ledger.md` referencing this ledger;
  add a one-line pointer in `AGENTS.md` ("When Stuck" section, like the auth_plan/auth_ledger line).
  Note the pinned decisions: registry sync = release job (never DDL); retrieval tools
  (`search_knowledge`/`search_memory`) become platform built-ins; BLOCK enforcement lives in the
  publish TX; no new version states (dead `VALIDATING`/`VALID`/`ROLLED_BACK` enum values stay
  reserved).
- **Depends:** none. **Gate:** docs review; AGENTS.md stays under 500 lines.

---

## TPL-1 — Registry schema + sync (plan PR-A)

### TPL-1.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `assistant_templates(slug, version [composite PRIMARY KEY — every released version kept for provenance reads and draft-from-version upgrades; the "(slug PK)" shorthand is superseded, see `drizzle/0048` header], status, family, definition jsonb, bindings jsonb,
  eval_ref jsonb, release_policy jsonb, hash, min_engine_schema, created_at)` — global, non-tenant
  (precedent: `billing.price_catalog`, `drizzle/0011_platform_services.sql:80-96` — no org column,
  no RLS); `assistant_installs(id, organization_id, slug, template_version, assistant_id FK,
  installed_by, installed_at)` — tenant table, RLS `ENABLE + FORCE` per the assistants shape
  (`drizzle/0020_assistants.sql:19-21`); indexes for installs lookups (org + slug@version). Journal
  bump + `ownership-map.json` entries (both tables, owner `engine-ts`). **Schema only — no template
  rows ship in DDL.**
- **Depends:** TPL-0.1. **Gate:** migration review; RLS negative tests for `assistant_installs`
  authored (application / worker / owner / BYPASSRLS).

### TPL-1.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** CI publishes `registry.json` (generated, hash-parity-checked against `definition/`);
  a release command upserts `assistant_templates` rows keyed `(slug, version)` — idempotent,
  audited (`template.registry_synced`), validates `hash` + `min_engine_schema` before write,
  refuses hash mismatch. Migrations are never used for template data.
- **Depends:** TPL-1.1, TPL-3.1 (generator produces `registry.json`). **Gate:** repeated upsert is a
  no-op; tampered `registry.json` rejected; no DDL required for a template bump.

### TPL-1.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `list(orgId)` returns `{template, available, compatibility: {status:
  COMPATIBLE|INCOMPATIBLE, reasons[]}}` — **never hides incompatibles**; machine-readable reasons:
  `required_model_capability_missing`, `required_tool_missing`, `knowledge_source_missing`.
  Compatibility must not assume a published `model_catalog` exists (the `rejectUnknownModels` check
  is opt-in — `assistants.service.ts:558-581`). `get(slug, version?)` returns the full BOM view.
- **Depends:** TPL-1.1. **Gate:** unit tests for each reason code; opt-in-catalog behavior covered.

### TPL-1.4 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** list endpoint over TPL-1.3 with `installed` + `update_available` flags (surfacing
  completes once TPL-2.2/TPL-4.1 land); org roles (`owner|admin|developer|reader|billing` read);
  bounded response (follow `AssistantsService.LIST_CAP` precedent); no raw row serialization.
- **Depends:** TPL-1.3. **Gate:** contract test; EXPLAIN for the list query.

---

## TPL-2 — Install path (plan PR-B; fixes G2/G3)

### TPL-2.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** accept optional `template?: {slug, version?}` OR `definition?: AssistantPayload`
  (Engine shape, validated by `validateAssistantPayload`, secrets rejected). **Make
  `assistantPayloadSchema` (`validation.ts:42`) `.strict()` or add an explicit unknown-key diff**
  so template-only extensions are rejected with a 422 listing them (non-strict zod currently strips
  unknown keys silently). Name-only create keeps working (back-compat).
- **Depends:** TPL-1.1. **Gate:** 422 lists every unknown key; legacy name-only create passes
  existing tests.

### TPL-2.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** one `withOrg` TX: `assistants` row + DRAFT version carrying the FULL Engine-subset
  template definition + `assistant_installs` row + outbox row (identity rows only — provisioning is
  async, TPL-2.3). Idempotency: `@Idempotent()` + domain key
  `organization_id + principal_id + 'template-install' + slug@version`. Audit `template.installed`
  (actor, scope, `slug@version`, hash, trace id). Response: `assistant_id + version_id +
  template_slug@version + hash`. Install is copy — no live link to the registry row.
- **Depends:** TPL-1.1, TPL-2.1. **Gate:** duplicate install is idempotent; concurrent installs of
  the same slug produce two independent assistants (no shared mutable state); TX rollback leaves
  zero partial rows.

### TPL-2.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** consume the install outbox event (inbox-dedup per `consumer.ts` contract): (a) tool-pin
  pre-resolution check — every non-built-in `tools.json` entry resolves to an ENABLED catalog row at
  the installing org (built-ins resolve by name, TPL-4/§6 rule); (b) knowledge-seed existence check
  against `bindings/knowledge.seeds.json`; (c) eval-dataset seeding — `template:<slug>@<version>`
  org-scoped `eval_datasets` + `eval_cases` from `eval/cases.jsonl` (+ `evaluators.yaml` recorded in
  eval_ref). Failures observable, retried by the dispatcher, never half-commit identity.
- **Depends:** TPL-2.2. **Gate:** unknown tool pin → compatibility failure/422 before any version
  row; redelivered event does not duplicate datasets (inbox dedup).

### TPL-2.4 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** installed `template_version` vs registry → `update_available: major | minor | none`;
  never auto-migrates installed assistants (runs stay pinned).
- **Depends:** TPL-1.2, TPL-2.2. **Gate:** unit tests for major/minor/none.

---

## TPL-3 — Template contents + lint (plan PR-C)

### TPL-3.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `products/agent-studio/templates/` (verified absent — no collision); per-template BOM
  layout per plan §4.2 (template.yaml, definition/ ×8, bindings/ ×3, eval/ ×3, release_policy.yaml,
  samples/ ×2, README.md, SETUP.md); generator emits `registry.json`
  `{slug, version, hash, status, min_engine_schema}` with canonical hash over `definition/`.
  Generated artifact — never hand-edited.
- **Depends:** TPL-0.1. **Gate:** generator output stable across runs; hash parity check green.

### TPL-3.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** CI lint running, in order: Studio `validateAgentDefinition` (7 rejection classes,
  `products/agent-studio/packages/agent-definition/src/validator.ts`) → Engine
  `validateAssistantPayload` (bounds = tighter of Engine/contract: instructions ≤20,000;
  `allowed_models` ≤16; tools ≤32; `knowledge_sources` ≤16; budget Engine names) → secret-pattern
  scan → `compileDefinition` hash parity → §5 instruction-standard checks (section order
  `Role→Goal→Grounding→Steps→Constraints→Tool use→Failure→Format`, ROLE line, grounded-task clause,
  banned-claims slot filled, `when_to_use` per tool, failure script, channel variants, provenance
  footer) → ≥10 eval cases + `evaluators.yaml` + `release_policy.yaml` present.
- **Depends:** TPL-3.1. **Gate:** lint rejects a deliberately broken fixture per rule class.

### TPL-3.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `brand-concierge`, `personal-aide`, `support-concierge`, `onboarding-guide`,
  `refund-specialist`, `knowledge-curator`, `sales-researcher`, `lead-qualifier`, `quote-builder`,
  `internal-helpdesk`, `devops-incident`, `voice-concierge` — distinguishing policies per plan §3
  table; worked pair per §4.3 (pins the real built-in `request_human_handoff`, not
  `escalate_handoff`); Engine-subset only in `definition/` (consumer fields in `console.json`);
  per-template `memory_scope` + poisoned-memory rules in instructions; `bindings/tools.required.json`
  pins `schema_hash` for every non-built-in tool.
- **Depends:** TPL-3.2. **Gate:** all 12 pass lint; reviewers sign instructions tone per template.

### TPL-3.4 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-7.5 — template-gates CI now references templates:lint)
- **Scope:** template-lint blocks merge; merge to main triggers the TPL-1.2 release-job upsert;
  hash-parity CI gate.
- **Depends:** TPL-3.3, TPL-1.2. **Gate:** a template PR lands with zero DDL and rows update.

---

## TPL-4 — Consumer API completion + provenance reads (plan PR-D)

### TPL-4.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** detail endpoint (`?version=`) returning full BOM definition + bindings + eval summary +
  release policy; `installed` + `update_available` surfaced on list (TPL-2.2/TPL-2.4 data); OpenAPI
  for all template endpoints; contract tests.
- **Depends:** TPL-1.4, TPL-2.2, TPL-2.4. **Gate:** contract tests green; OpenAPI drift check added.

### TPL-4.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** version GET/export responses carry `template_slug@version`, manifest hash (once
  TPL-5.5/5.6 land), `update_available`, last EvaluationRun `decision`; upgrade = new draft from
  vX.Y.Z, never mutate published.
- **Depends:** TPL-4.1, TPL-5.5. **Gate:** provenance fields present and correct for an installed
  template version.

---

## TPL-5 — Manifest + provenance (plan PR-E; plan §7.2 item 2 + §3.5)

### TPL-5.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** (a) `policy_snapshots` += `tool_bindings jsonb NOT NULL DEFAULT '[]'`, `knowledge_pins
  jsonb`, `model_ref jsonb`, `template_ref jsonb {slug, version, definition_hash}`,
  `manifest_hash varchar(64)`; (b) new `run_manifests(run_id PK FK → runs, organization_id RLS,
  assistant_version_id, policy_snapshot_id, manifest jsonb, manifest_hash, created_at)` — RLS
  ENABLE+FORCE; (c) `eval_runs` += `provenance jsonb`, `decision varchar(16)` CHECK
  `('PASS','WARN','BLOCK')`, `release_policy_version int`; (d) `assistant_rollouts` += `environment
  varchar(32) DEFAULT 'production'`, `channel varchar(32) DEFAULT 'default'` + uniqueness per
  `(assistant_id, environment, channel) WHERE state='active'` — **replaces
  `uq_rollouts_active_per_assistant`: destructive constraint change, document drop/replace with
  rollback note**; (e) `assistants` += `disabled_at, disabled_by, disabled_reason`; (f) new
  `control_blocks(id, organization_id RLS, target_type CHECK ('assistant','version','tool',
  'template','capability'), target_name, reason, expires_at, created_by, created_at)` — RLS
  ENABLE+FORCE. No new version states — `VALIDATING`/`VALID`/`ROLLED_BACK` stay reserved-dead
  (verified: only `DRAFT`/`PUBLISHED`/`RETIRED` are written by `assistants.service.ts`).
- **Depends:** TPL-1.1. **Gate:** journal + ownership-map deltas; expand/contract notes; RLS
  negative tests for `run_manifests` + `control_blocks`.

### TPL-5.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** in the publish TX, resolve each `tool_policy.tools[]` entry into a stored ToolBinding on
  the snapshot: `{tool_id/name, tool_version (catalog row at publish), schema_hash, capability_class
  (Neryva-owned READ_ONLY|MUTATING|DESTRUCTIVE), authorization_policy ref, approval_mode
  (REQUIRED|NONE), credential_binding ref (sealed id only — never secret material), timeout_ms (from
  catalog http_binding), retry_policy, rate_limit_per_run}`. Capability classification stays
  Neryva-owned (catalog metadata → classification → authorization → approval); MCP tool annotations
  are never trusted (spec 2025-06-18 rule).
- **Depends:** TPL-5.1. **Gate:** binding fields match the catalog row at publish instant; mutated
  catalog after publish does not alter the stored binding; no secret material in the jsonb.

### TPL-5.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** resolve each `context_policy.knowledge_sources` slug into
  `policy_snapshots.knowledge_pins`: `{source_slug, document_version_ids[], document sha256s,
  embedding_model (documents.embedding_model, knowledge/schema.ts:105), knowledge_config published
  id + payload hash, chunking params}` (primitives: `document_versions` at `knowledge/schema.ts:112-126`).
  A corpus that moved after pinning = a new pin requiring a new version — never a silent change.
- **Depends:** TPL-5.1. **Gate:** pin content hash matches documents at publish; corpus update after
  publish leaves the pin unchanged.

### TPL-5.4 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** resolve `model_policy.allowed_models` aliases into `policy_snapshots.model_ref`:
  `{provider, model, catalog config record id + payload hash, entry hash, model_params}`. Honesty
  bound: no provider-revision pinning (the catalog carries no revision field —
  `config-publish/payload-schemas.ts:120-151`); manifest records everything Neryva controls.
- **Depends:** TPL-5.1. **Gate:** same-catalog reproducibility; unknown alias still rejected by
  `rejectUnknownModels` first.

### TPL-5.5 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** write `policy_snapshots.template_ref {slug, version, definition_hash}` at publish for
  template-installed assistants (provenance, not a live link) and compute `manifest_hash` over the
  resolved binding set (tool_bindings + knowledge_pins + model_ref + guardrail/policy references +
  compiler version). The transient per-call `ContextManifest` (GetAuthorizedRunContext) is NOT the
  stored manifest — keep them distinct in code and docs.
- **Depends:** TPL-5.2, TPL-5.3, TPL-5.4. **Gate:** same inputs → byte-identical manifest_hash.

### TPL-5.6 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** in the run-acceptance TX (`conversations` module), insert `run_manifests` row: snapshot
  + binding references + conversation/input-message/channel/release pointer + `manifest_hash` —
  extends the existing pin (`runs.assistant_version_id + policy_snapshot_id`,
  `conversations/schema.ts:103-109`) to every mutable dependency without changing those columns.
- **Depends:** TPL-5.5. **Gate:** acceptance TX is atomic; kill -9 after the boundary leaves either
  no run or a complete manifest; duplicate acceptance cannot double-insert (idempotency tier).

### TPL-5.7 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-7.5 — golden fixture gate wired)
- **Scope:** reproduce one Tier-1 template's full ExecutionManifest byte-identically from the same
  inputs; `manifest_hash` verifies; recorded as a CI fixture.
- **Depends:** TPL-5.6. **Gate:** fixture green in CI.

---

## TPL-6 — Release policy + promotion + kill switches (plan PR-F)

### TPL-6.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** publish requires the latest `eval_runs.decision` for that version hash ≠ `BLOCK`
  (enforced **in the publish TX** — no client can bypass); typed error on attempt; required checks +
  `critical_failures` from the template `release_policy.yaml` (plan §4.4); WARN releases carry the
  warning forward. Data arrives from TPL-7.
- **Depends:** TPL-5.1 (decision column), TPL-7.3. **Gate:** critical-fail version is mathematically
  unpublishable (test returns the typed BLOCK error); concurrent eval completion cannot slip past
  the TX check.

### TPL-6.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `GET/PUT .../assistants/:assistantId/releases` over the extended `assistant_rollouts`
  (environment + channel + `{version_id, weight}` weights); promotion = pointer move, never a
  rebuild (Bedrock alias pattern); rollback = repoint (history preserved) or restore-as-new-version
  (`rollback_of` lineage) — both append-only; audit `release.promoted{env, weights}`; operator roles
  (`admin`/`owner`); per-customer pinning falls out of dedicated channels.
- **Depends:** TPL-5.1. **Gate:** weights-sum validation; canary split sticky per conversation;
  rollback leaves an audit trail; auto-rollback on burn-rate explicitly deferred (phase 2).

### TPL-6.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** enforce inside existing per-RPC transactions, effective next call, no cache:
  `tool_catalog.enabled=false` now checked at `authorizeToolCall`
  (`mcp-authority.service.ts:843-858` — today unchecked), context-assembly tool resolution, and
  `getToolCredential` (`:536-552` — today unchecked); `assistants.disabled_at` blocks run-accept;
  version-level disable (via control_blocks, target `version`) blocks release-pointer assignment.
  In-flight runs fail closed at their next tool authorization; every check audited.
- **Depends:** TPL-5.1, TPL-6.4. **Gate:** disabled tool denied at authorize with audit record;
  kill-to-deny covered by the per-RPC check (no cache invalidation path); run-accept blocked for a
  disabled assistant.

### TPL-6.4 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `GET/POST/DELETE .../control-blocks` (operator roles only) covering target types
  `assistant | version | tool | template | capability` with `expires_at`; audit
  `control.block_set` / `control.block_cleared`; expired blocks stop applying (evaluated at check
  time).
- **Depends:** TPL-5.1. **Gate:** expiry honored without a sweeper; non-operator role denied;
  audit records complete.

### TPL-6.5 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** map the seven governance functions onto the existing five org roles
  (`owner|admin|billing|developer|reader`, `org-roles.guard.ts:15`): Template Administrator →
  platform staff; Developer/Evaluator → `developer`+; Reviewer/Approver → `admin`/`owner` with
  `approved_by` recorded; Publisher → `owner`/`admin` (step-up as today, `published_by` recorded);
  Operator → `admin`/`owner`; End User → participant with zero control-plane rights. Strict
  approver≠author separation ships as opt-in phase 2 — recorded here, not enforced.
- **Depends:** none (docs + route role assignments across TPL-4/6/7). **Gate:** every new route
  declares roles consistent with this mapping.

---

## TPL-7 — Eval gate wiring (plan PR-G; §7.2 item 5, §4.4)

### TPL-7.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** finalize the TPL-2.3 seeding: dataset named `template:<slug>@<version>`, cases from
  `eval/cases.jsonl` with `{input, context_refs, expected_behavior, must_cite, must_not,
  tools_expected}` mapped into `eval_cases(input, expected, rubric, sequence)`, evaluators recorded.
  Marks generated data as test data (ledger 3.5 rule).
- **Depends:** TPL-2.3. **Gate:** re-install of the same slug@version does not duplicate datasets.

### TPL-7.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** thin route over the existing `EvalService.startRun`
  (`knowledge/eval.service.ts:129-166` — PUBLISHED-only gate at `:142` and the outbox
  `eval.run_requested` handoff stand unchanged); template-seeded dataset selected automatically;
  response carries `eval_run_id`; decision polled from `eval_runs.decision`. Developer+ roles.
- **Depends:** TPL-7.1, TPL-5.1. **Gate:** DRAFT versions rejected (PUBLISHED-only preserved);
  outbox event emitted in the same TX.

### TPL-7.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** write `decision` + `release_policy_version` on completed eval runs (eval-worker result
  path); audit `template.version_evaluated{decision}`; expose the decision via TPL-4.2 provenance.
- **Depends:** TPL-7.2. **Gate:** BLOCK/PASS/WARN recorded and visible on the version read.

### TPL-7.4 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `eval_runs.provenance` records the full §4.4 set: template `slug@version + definition
  hash`, dataset content hash at run time, evaluator versions, model reference (provider/model +
  catalog config id + hash + generation config), tool catalog snapshot hash at run time, knowledge
  pins, guardrail reference (snapshot hash) + `COMPILER_VERSION`, environment pointer, seed,
  `attempts_per_case`, per-case results. Score-only provenance is a bug.
- **Depends:** TPL-7.2, TPL-5.2-5.5. **Gate:** golden EvaluationRun per Tier-1 template with
  complete provenance in CI fixtures.

### TPL-7.5 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** new version evaluated on the previous released version's dataset;
  `release_policy.regression_no_worse_than` (e.g. 0.02) computed by experiment comparison, not a
  bare score; result feeds the §4.4 decision model.
- **Depends:** TPL-7.3. **Gate:** a regressed version yields WARN/BLOCK per policy.

---

## TPL-8 — Observe → evolve loop (plan PR-H; §9.5)

### TPL-8.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** production-trace evaluators (safety, groundedness, policy) write to the existing
  `run_judgments` (`knowledge/eval.schema.ts:68`) + `message_feedback` + `analytics_rollups` — new
  evaluator wiring only, no new stores; scores/verdicts only (transcript content re-read through the
  claim-check path, never copied into the judgment row).
- **Depends:** TPL-7.4. **Gate:** judgments append-only; no transcript content in rows or logs.

### TPL-8.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** failing traces become *candidate* `eval_cases` requiring curator confirmation before
  entering any dataset — never auto-ingested (prompt-injection must not write the test suite).
- **Depends:** TPL-8.1. **Gate:** injected production failure appears as candidate only; curator
  approval required; rejection path audited.

### TPL-8.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** every new template/assistant version re-runs the accumulated dataset (including
  promoted production failures) under the release policy before its release pointer moves
  (composition with TPL-6.2).
- **Depends:** TPL-8.2, TPL-6.1. **Gate:** pointer move blocked while the accumulated-dataset run
  is BLOCK.

---

## TPL-9 — Tier-2 templates + channels (plan PR-I)

### TPL-9.1 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `market-analyst`, `competitive-intel`, `data-analyst`, `appointment-setter`,
  `renewal-expansion`, `hr-policy-aide`, `finance-reconciler`, `field-service-guide` — same lint +
  release-policy gates as Tier 1.
- **Depends:** TPL-3.4. **Gate:** all 8 pass §9 template-CI.

### TPL-9.2 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** per-template channel bindings (widget/WhatsApp/Messenger/Telegram/voice) consumed by
  the existing channel plane; per-channel caps enforced server-side. Agent channel bindings are NOT
  `channel_message_templates` (Meta provider templates, `drizzle/0042_fl3_frontier.sql:94-115`) —
  keep the names apart in code and UX.
- **Depends:** TPL-3.3, TPL-6.2. **Gate:** per-channel cap enforced server-side; no cross-concept
  reuse.

### TPL-9.3 
- **Status:** CODE_COMPLETE (2026-09-13 review pass — code landed; DB-backed gates await the first authorized full run)
- **Scope:** `voice-concierge` (and voice variants) evaluated on spoken-format rules (≤2 sentences,
  confirm-back, frustration handoff) via the release policy.
- **Depends:** TPL-7.4, TPL-9.1. **Gate:** voice template passes the spoken-format eval.

---

## TPL-10 — Exit gates (plan §9 + §12 definition of done)

### TPL-10.1 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-0.5 — isolation suite now required)
- **Scope:** two-org install of the same slug cannot read/mutate each other's
  assistants/versions/snapshots/installs/manifests, knowledge, or eval runs; registry (global) is
  readable but installs are strictly per-org.
- **Depends:** TPL-2.2, TPL-5.6. **Gate:** isolation suite green.

### TPL-10.2 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-0.5)
- **Scope:** `exportVersion` hash parity round-trip for at least one version per Tier-1 template
  (provenance fields included without breaking canonical hashing).
- **Depends:** TPL-3.3, TPL-4.2. **Gate:** round-trip identical for all 12.

### TPL-10.3 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-0.5)
- **Scope:** `samples/edge-cases.md` scenarios executed: prompt-injection exfil, confused-deputy tool
  args, stale-version publish race, capability-scope swap, disabled-tool invocation — all fail
  closed with audit records.
- **Depends:** TPL-6.3, TPL-6.4. **Gate:** every scenario denies + audits.

### TPL-10.4 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-0.5)
- **Scope:** existing Phase 3 gates unchanged and extended: advisory-lock concurrency, no-op hash
  conflict, snapshot + bindings + manifest-hash in-TX, run manifest in acceptance TX, tool-pin
  drift rejection, built-in bypass correctness.
- **Depends:** TPL-5.2-5.6. **Gate:** existing + new tests green.

### TPL-10.5 
- **Status:** CODE_COMPLETE (2026-09-14 via release_ledger REL-7.4 — OpenAPI drift gate)
- **Scope:** OpenAPI drift on all new endpoints blocks merge (§7.3); `AGENTS.md`/`imp/ledger.md`
  statuses reconciled in the same PR that flips the last task; DoD checklist (plan §12) fully
  checked.
- **Depends:** all above. **Gate:** merge gate active; docs updated.

---

## Status tally (update in the same PR that changes any status)

Updated 2026-09-13 (implementation review pass): all Engine + template-content tasks are
CODE_COMPLETE; every DB-backed exit gate awaits the single authorized full CI/DB run (compose up +
migrate + suites) before any box may move past GATES_PENDING. Now CODE_COMPLETE via release_ledger REL-7.5/REL-0.5: TPL-3.4 (CI workflow now
references `templates:lint` yet — lint runs locally), TPL-5.7 (golden manifest fixture is authored
with the CI gate), and the five TPL-10 exit-gate tasks.

| Phase | TODO | CODE_COMPLETE | GATES_PENDING | DONE |
|---|---|---|---|---|
| TPL-0 | 0 | 2 | 0 | 0 |
| TPL-1 | 0 | 4 | 0 | 0 |
| TPL-2 | 0 | 4 | 0 | 0 |
| TPL-3 | 0 | 4 | 0 | 0 |
| TPL-4 | 0 | 2 | 0 | 0 |
| TPL-5 | 0 | 7 | 0 | 0 |
| TPL-6 | 0 | 5 | 0 | 0 |
| TPL-7 | 0 | 5 | 0 | 0 |
| TPL-8 | 0 | 3 | 0 | 0 |
| TPL-9 | 0 | 3 | 0 | 0 |
| TPL-10 | 0 | 5 | 0 | 0 |
| **Total** | **0** | **44** | **0** | **0** |

> **Execution order:** TPL-0 → TPL-1 → TPL-2 → TPL-3 (3.1/3.2 can start after TPL-0 in parallel
> with TPL-2) → TPL-4 → TPL-5 (5.1 may start after TPL-1.1, parallel with TPL-2/3) → TPL-6 →
> TPL-7 → TPL-8 → TPL-9 → TPL-10. PR mapping: TPL-1=PR-A, TPL-2=PR-B, TPL-3=PR-C, TPL-4=PR-D,
> TPL-5=PR-E, TPL-6=PR-F, TPL-7=PR-G, TPL-8=PR-H, TPL-9=PR-I. `checkUpdates` service logic is
> TPL-2.4; its endpoint surfacing is TPL-4.1 (plan §10 lists it under PR-D — split recorded here).

---

## Traceability matrix — plan feature → task (no-feature-missed check)

| Plan section / feature | Task(s) |
|---|---|
| §0 controlling invariants 1–3 | Rules header; TPL-5.5-5.7; TPL-6.1 |
| §1.3 G1 (no registry) | TPL-1.1-1.4 |
| §1.3 G2 (create drops definition) | TPL-2.1, TPL-2.2 |
| §1.3 G3 (no tool/knowledge binding) | TPL-2.3, TPL-5.2, TPL-5.3 |
| §1.3 G4 (no eval gate) | TPL-7.1-7.5 |
| §1.3 G5 (no instruction standard) | TPL-3.2, TPL-3.3 |
| §1.3 G6 (no canonical registry) | TPL-1.2, TPL-4.1 |
| §1.3 G7 (no lifecycle) | TPL-2.4, TPL-4.1 |
| §3 taxonomy 12 Tier-1 + 8 Tier-2 | TPL-3.3, TPL-9.1 |
| §3.5 four-artifact model + TemplateRelease≠AssistantVersion | TPL-2.2 (install-as-copy), TPL-5.5-5.6 |
| §4.1 frontmatter (hash, min_engine_schema) | TPL-3.1, TPL-1.2 |
| §4.2 BOM (18 files, Engine subset + consumer-only split) | TPL-3.1, TPL-3.2 |
| §4.4 release_policy.yaml (PASS/WARN/BLOCK) | TPL-3.1, TPL-6.1 |
| §4.4 EvaluationRun provenance record | TPL-5.1(c), TPL-7.4 |
| §5 instruction standard (9 rules) | TPL-3.2, TPL-3.3 |
| §6 tool/approval matrix; catalog row vs version entry | TPL-3.3, TPL-5.2 |
| §6 ToolBinding stored on snapshot | TPL-5.1(a), TPL-5.2 |
| §6 Neryva-owned classification (MCP hints untrusted) | TPL-5.2 |
| §6 retrieval tools as built-ins (`search_knowledge`/`search_memory` join `BUILT_IN_TOOLS`) | TPL-2.3 (code change + pre-resolution), TPL-3.3 (template pins), TPL-5.2 (verification) |
| §6 enabled-check gap (verified) | TPL-6.3 |
| §7.2 item 1 migration 0048 (schema only) | TPL-1.1 |
| §7.2 registry sync release job | TPL-1.2, TPL-3.4 |
| §7.2 item 3 TemplatesService list/get/install/checkUpdates | TPL-1.3, TPL-2.2, TPL-2.4 |
| §7.2 item 3 outbox-driven provisioning | TPL-2.3 |
| §7.2 item 4 create accepts template/definition + strict 422 | TPL-2.1 |
| §7.2 item 5 eval gate on existing machinery | TPL-7.1, TPL-7.2 |
| §7.2 item 5 BLOCK in publish TX | TPL-6.1 |
| §7.2 item 6 kill switches (5 levels) | TPL-6.3, TPL-6.4 |
| §7.2 item 7 RBAC mapping + SoD opt-in | TPL-6.5 |
| §7.2 item 8 audit events | TPL-1.2, TPL-2.2, TPL-6.2, TPL-6.4, TPL-7.3 |
| §7.3 endpoints 1–6 + OpenAPI drift | TPL-1.4, TPL-4.1, TPL-2.1/2.2, TPL-7.2, TPL-4.2, TPL-6.2, TPL-6.4, TPL-10.5 |
| §7.4 update_available, pointer promotion, rollback append-only, registry.json CI | TPL-2.4, TPL-6.2, TPL-1.2 |
| §8 retrieval layer (pinned knowledge) | TPL-5.3 |
| §8 model pinning honesty bound | TPL-5.4 |
| §8 memory rules (propose→approve, poisoned-memory quarantine) | TPL-3.3 (per-template settings; Engine memory plane exists) |
| §9 template CI gates | TPL-3.2, TPL-10 |
| §9.5 observe→evolve (judgments, human-gated promotion, regression) | TPL-8.1-8.3 |
| §10 PR-A…PR-I | TPL-1…TPL-9 (mapping above) |
| §12 DoD checklist | TPL-10 |

> Note on the §6 built-ins row: adding `search_knowledge`/`search_memory` to `BUILT_IN_TOOLS`
> (`tool-catalog.service.ts:90-148`) is a small code change executed with TPL-2.3 (the first
> consumer of built-in resolution) and verified by TPL-5.2; template pins for them are authored in
> TPL-3.3.
