# Agent Setup — Knowledge, Templates, Multi-Agent, Providers

> Status: system IMPLEMENTED 2026-09-15 (code complete; DB-backed exit gates pending the first full CI/DB run, same as every ledger). This document is the setup-plane source of truth for the frontend build.
> Owner: Frontend team + Engine platform team.
> Scope: **how teams set up agents end to end** — knowledge (uploads + connectors + mapping) → template install → provider/model choice → authoring → test → evaluate → publish → operate → observe. Every Engine claim cited to `engine/src`; every role set copied from route decorators.
> Non-goals: changing tenancy/RLS, billing math, the MCP wire contract, or Studio execution internals. Cross-agent orchestration stays out (§11).
> Research basis: Intercom Fin (per-agent sources, audiences, Copilot, content gaps), Copilot Studio (per-agent picker, admin controls, Agent Library, child-vs-connected), Salesforce Agentforce (managed/BYOK duality, single-org multi-agent), Sierra/Decagon/KoreESTAMP (traces, evals, connectors, permission sync, outcome metrics).
> Verification: all citations re-checked against `engine/src` + `products/agent-studio` on 2026-09-15 (this pass corrected 9 inaccuracies in the prior revision: step-up scope, burn-rate API, E-1/E-2 status, ACL-shape freeze, preview route shape, suspend matrix, fingerprint behavior, template count, reference line numbers). Paths repo-root-relative.

---

## 0. Direct answers

1. **Knowledge for a customer-service agent:** teams add documents two ways — **uploads** (presigned POST → scan → extract → index → READY) and **connectors** (Drive, SharePoint, Confluence, Notion, Zendesk, Slack, sitemap with incremental sync, OAuth or sealed static credentials). Every document carries an immutable org-unique **`source_slug`** pin address. The agent declares slugs per version (`context_policy.knowledge_sources`); publish resolves them to exact document versions (`knowledgePins`: IDs, sha256, parser/embedding versions, manifest hash); runtime retrieval is constrained to pinned versions inside the scoring query, with source-permission allow-lists enforced in the same statement.
2. **Template fit:** the template declares knowledge (`bindings.knowledge.required[]` slugs + seeds + evaluators that cite them). Install copies the declaration; the provisioning worker verifies seeds against READY slugs (retryable); publish pins slugs to versions; eval proves grounding. Template = contract, pins = fulfillment, eval = proof. Imports never go live by themselves (install writes DRAFT v0; the active pointer is untouched).
3. **One org, many independent agents — yes, natively.** `assistants` rows per org with unique names; own versions/snapshots/manifests; `conversations.assistantId NOT NULL`; runs pin version+snapshot. Independent: instructions, tools, knowledge pins, models, budgets, guardrails, releases, kills. Shared by design: document pool, tool catalog, provider credentials, billing.
4. **Provider choice, two tiers:** admins govern (org model allowlist, BYOK sealed keys, enablements, residency, cost catalog, trial caps); makers pick per agent (`allowed_models`, publish-validated with per-model disable reasons). Draft roles: owner/admin/developer. Publish and keys: owner/admin. Provider-credential create/rotate additionally require a fresh MFA proof; revoke stays proof-free so incident response never waits.

---

## 1. Data model (exact)

- `assistants(id, organization_id NOT NULL, name, active_version_id, disabled_at, kill flag)` — unique `(organization_id, name)`; duplicate install/create → 409.
- `assistant_versions(id, assistant_id, organization_id, version int, instructions, model/context/tool/guardrail/knowledge policies, model_params, budget_policy, hash, status, rollback_of)` — immutable; statuses DRAFT → … → PUBLISHED → RETIRED; rollback points at a prior immutable row (restoring non-active payload legitimate; republishing identical content rejected as no-op).
- `policy_snapshots(id, assistant_version_id UNIQUE, *-policy mirrors, toolBindings, knowledgePins, modelRef, templateRef, manifestHash)` — materialized in the publish TX, 1:1 with the published version.
- `run_manifests(run_id PK, version/snapshot ids, manifest jsonb, manifestHash)` — written in the run-acceptance TX (accept/regenerate/edit); heavy truth stays on the snapshot.
- **Serve path (how traffic finds the agent):** channels require `default_assistant_id` (validated + routability-checked at bind time — a channel conversation pins its account's assistant); every conversation carries a mandatory `assistantId` (no default at create — the caller chooses); each run resolves its version via `pickVersionPin`: channel release pointer → rollout weighted variants → active published version (PUBLISHED-only; drafts/retired never serve). Run acceptance additionally refuses disabled assistants and assistant-level blocks with typed conflicts.
- `documents(id, organization_id, source_artifact_id UNIQUE, title display-only, state processing|ready|failed|retired, source_slug NOT NULL UNIQUE per org, embedding_model)` → `document_versions(document, version int ascending, sha256, parser_version)` → `chunks(version, sequence, text ≤8192, source_range byte offsets)` → `embeddings(chunk, model, vector<1536>)`. Naming convention (intentional, matches DDL — do not rename): documents.embedding_model names the active model; embeddings rows key by model with the vector in embedding.
- `retrieval_acl(document, organization|private)` + `document_source_acls(document, provider, external_id)` allow-lists + `external_principals` + `external_identity_links` (auto-created on email equality at sync).
- `upload_sessions` carry intent into ingestion: `source_slug`, `title`, `target_document_id` (re-ingest appends a version), `connector_ref`, `source_acl`.
- `connector_accounts(provider, sealed credentials, cursor, state)` + `connector_oauth_apps(org, provider)` (BYO apps) + `connector_documents` (external-id map for tombstoning).
- `control_blocks(assistant|version|tool|template|capability, reason, expiry)` — no warn mode; expiry needs no worker.
- Eval: datasets/cases/runs/results + `decision` PASS|WARN|BLOCK + provenance + `run_judgments`.
- Analytics: `analytics_rollups(org, kind, period, scope, metrics)` — org kinds (`csat_daily`, `conversation_outcomes`, `usage_daily`) + per-assistant twins (`assistant_*`, scope `{"assistant_id"}`).

## 2. Setup state machine (the funnel)

```text
INSTALL (template copy → DRAFT v0, or blank definition)
  → CONFIGURE (instructions/tools/knowledge/models/guardrails/budgets — validated live, §5)
  → MAP KNOWLEDGE (required slugs → READY docs via upload/rename/connector, §3)
  → TEST-RUN (run_kind='test': no quota, no billing, pinned to draft)
  → EVALUATE (decision + provenance; BLOCK/WARN surface with re-run paths)
  → PUBLISH (atomic pointer swing; BLOCK refuses; manifest hash recorded)
  → OPERATE (rollout/release pointers, kills, burn-rate, per-assistant metrics)
```

Every transition is explicit and audited; nothing auto-publishes; in-flight runs stay pinned to superseded versions.

## 3. Slice A — knowledge (uploads + connectors + mapping + enforced pins)

- **Uploads** (owner/admin/developer): `POST …/uploads {purpose, media_type, byte_length, sha256, source_slug?, title?}` → presigned POST (exact size/sha window) → direct PUT → `POST …/complete` (server verifies bytes + bound sha) → stage tracker (`GET …/uploads/:id`: CREATED→…→READY / QUARANTINED|FAILED with reason). Slug: kebab 3–64, reserved now (409 `source_slug_taken`); omitted → derived `doc-{artifact8}`; title defaults to slug, else auto.
- **Inventory + mapping:** `GET …/documents` (slug/title/state/latest version, newest first) + `POST …/documents/:id/source-slug` (owner/admin/developer, audited, 409 on collision; old pins referencing the prior slug resolve visibly unresolved next publish — history never rewritten).
- **Connectors** (link: owner/admin/developer; OAuth apps + dance: owner/admin): sitemap (no auth) + Drive (per-org OAuth dance) + SharePoint (Entra client-credentials) + Confluence/Notion/Zendesk/Slack (sealed static credentials, shape-validated at link: Drive rejects pasted secrets with a dance pointer). Sync: fresh credentials (auto-refresh with skew) → bounded fetch (pagination + iteration caps, per-doc skips with reasons, never sync failures) → mapping-aware versioning (no duplicates) → tombstones for source deletions (`retired`, mapping kept for resurrection) → cursor + counts. Sealed material never appears in list responses (`hasCredentials` only).
- **Permission sync:** adapters capture source verdicts (Drive/Graph open on anyone/domain, else user/group principals; Confluence restrictions; Zendesk segments; Slack public-share; Notion workspace-scoped open, documented) → ingestion upserts principals, auto-links on email equality, replaces per-doc allow-lists. Retrieval admits restricted docs only to linked accounts or matching verified emails; anonymous callers see unrestricted docs; unknown principals default-deny. All inside the scoring WHERE — never post-filtered.
- **Runtime pins (E-1):** `allowedDocumentVersionIds` = undefined (unpinned legacy: org-wide) or resolved IDs ([] = fail-closed to nothing); enforced in both vector and lexical legs; both MCP paths (context assembly + `SearchKnowledge`) pass the run's snapshot pins; console search and eval recall stay explicitly unconstrained. Reranker reorders only, never widens.
- **Rules that stay:** `retrieval_enabled` defaults OFF (deliberate toggle, no silent fallback); snippets PII-redacted + spotlighted untrusted; citations pin version + byte ranges; non-READY/retired/expired/quarantined docs unreachable by construction; retrieval legs logged as durable run events.

## 4. Slice B — template install (guided, never auto-published)

Gallery (20 BOMs: scenario/family/status/version + compatibility panel) → detail (BOM tabs: definition, tool bindings with effect+approval, knowledge reqs, channels+caps, eval rubric + release policy; per-reason rows — `required_model_capability_missing`, `required_tool_missing`, `knowledge_source_missing`, `provider_credential_missing` — each linking its fix) → Install (name, default = template name; duplicate → 409) → one-TX copy (assistant + DRAFT v0 + install row + provisioning outbox) → post-install checklist: ① map MISSING slugs (§3) ② tool pins auto-resolved, drift flagged ③ models picked with reasons ④ credentials (owner/admin) ⑤ test-run ⑥ evaluate → explicit publish. Provisioning retries tool/seed gaps; sustained absence dead-letters for replay.

## 5. Slice C — providers (govern tier + maker tier)

- **Govern (owner/admin):** published `model_catalog` allowlist (entries, fallback order, regions, cost ceilings) + residency pin (`default` permissive / `eu` strict, fail-closed) + BYOK credentials (create/rotate/revoke, fingerprints-only lists, envelope-sealed, step-up on create/rotate (revoke proof-free) + per-provider enablements (default on) + trial caps/budgets view. Staff plane never linked. Config-catalog publishes carry step-up, as do provider-credential create/rotate.
- **Maker (owner/admin/developer):** `allowed_models` picker from `GET …/models` (usable + reasons as inline disable-reasons). Draft advisory, publish enforcement (`rejectUnknownModels` + residency + `assertToolPins` + `assertPublishable` in one ordered gate).
- **Money visible at setup:** per-agent budgets (tokens ≤2M, cost, wall-clock ≤24h, tool calls ≤1000, model calls ≤200), cost preview where priced (unpriced labeled, never zero-implied), trial caps from env (unset = unlimited, non-numeric fails closed at boot).

## 6. Slice D — authoring reference (the strict core)

- **Caps (contract-enforced, tighter wins):** instructions ≤20,000 (Engine type allows 32,768; publish requires non-empty); models 1–16 (`provider/model` shape); tools ≤32 entries `{name ^[a-z0-9_]+$, access read|write, approval required|none default none, schema_hash? 64hex}`; history 1–100 (default 30); retrieval results 1–20 (default 5); budgets per §5.
- **Vocabulary mapping (single module, never per view):** consumer `never|on_effect|always` → Engine `optional|required` + catalog `REQUIRED`; `memory_scope` `org` → `organization` (Engine `user` has no consumer value — omit); `max_context_tokens`/`retrieval_policy`/`brand` are contract/consumer-side, never Engine version fields; tool entries carry only name/access/approval/schema_hash (effect class lives on the catalog row).
- **Three gates:** shape (zod + contract schema, every write) → policy (publish TX: instructions, tool-pin freshness, model/residency allowlist, budgets, BLOCK latest-decision check, unresolved-pin refuse unless acknowledged) → runtime (run acceptance, `authorizeToolCall`, context assembly, credential issuance, install). Failures are typed 422/409 with reasons; secret shapes (credential-assignment patterns, secret-named keys) rejected before persistence; unknown keys 422 with dotted paths at every depth (never silently stripped); draft edits go through PUT with required If-Match on the row hash (412 + both hashes on stale, never silent clobber; same-hash saves idempotent); DRAFT-only discard endpoint for abandonment.
- **Studio mirror:** validator 7 classes (unknown capability/tool, effectful-without-approval, over-entitlement, unsupported context, unbounded recursion, instructions-authority) + compiler (hashes, per-tool schemas, `COMPILER_VERSION`). Template CI runs Studio first, Engine second.

## 7. Slice E — test → evaluate → publish → operate

- **Test-run** (`POST …/versions/:v/test-runs`, owner/admin/developer): `run_kind='test'`, pinned to draft, no quota/billing. **Evaluate** (`POST …/evaluate` → `eval_run_id`): rubric + cases + provenance → decision; promote/reject candidates feed the observe loop.
- **Publish/rollback/retire** (owner/admin): advisory-locked atomic pointer moves; export/import deterministic with `schema_version`; snapshot/provenance reads for all roles. **Disable/enable/delete** (owner/admin); delete is lifecycle-gated, not instant.
- **BLOCK semantics (latest-wins):** BLOCK refuses publish AND rollout/release promotion; a later PASS clears it; WARN blocks only where templates declare required checks. UI renders decision + provenance + re-evaluate path, never a bare error. Unresolved knowledge pins refuse the same way (422 with slugs) unless acknowledge_degraded_knowledge is set (audited bypass).
- **Operate:** rollout set/pause (owner/admin; BLOCKed versions unassignable; platform kills second the effect), release pointers env×channel (owner/admin; channel-routability enforced), control blocks CRUD (owner/admin; enforced at run acceptance, release assignment, `authorizeToolCall`, context, credential issuance, install — terminal commits deliberately unsupported so runs never strand), assistant kill flag (blocks acceptance, audited). Rollouts support weighted variants (1–10 versions, positive-integer weights summing to exactly 100, sticky per conversation) — the built-in A/B + canary primitive; pause is the emergency lever. Day-1 emergency UI = exactly two toggles here (pause rollout + disable/kill) with confirm modals; analytics/anomaly/variant sliders stay deferred. **Burn-rate is service-only** (no controller routes exist — operate UI surfaces rollout state + audit, and triggers the existing service path; do not spec a burn-rate endpoint that isn't there). Paused rollouts carry paused_reason/by/at (manual = actor, burn-rate = reason+costs) — banner verbatim; NULL reason on pre-attribution rows reads as operator-paused.
- **Observe:** per-assistant `assistant_*_daily` rollups (containment = completed ÷ (completed + escalated), null on empty; CSAT up/down/ratio; runs/tokens/cost) via `GET …/analytics/rollups?kind=&days=&assistant_id=`; briefed handoff (immutable brief-at-escalation: summary + open run + last customer message); knowledge-gap loop (eval misses + low-score legs + judgments → new-doc tasks) is next-build console work on existing events. Knowledge health (`GET :assistantId/knowledge-health`: per-pin slug/resolved/state + degraded flag over the ACTIVE version's pins) drives the operate-view degraded banner; burn-rate auto-pauses carry paused_reason/by/at with a manual-resume cooldown (hourly sweep, spend-gated candidates, `suppressed` action inside the window — the ledger is never reset).

## 8. Endpoint + role reference (setup scope)

Assistants: create/list/get owner/admin/developer…reader/billing-read as marked — create+versions+test/evaluate/import/draft-edit/draft-discard `owner,admin,developer`; knowledge-health `owner,admin,developer,reader,billing` (`assistants.controller.ts:122-124`); publish/rollback/retire/disable/enable/delete `owner,admin` (publish/rollback accept optional acknowledge_degraded_knowledge); reads (list/get/versions/export/snapshot/provenance) all roles incl. billing. Templates list/get all roles. Tools: upsert/from-template `owner,admin,developer`; enabled-toggle `owner,admin`; reads all-ish. Models read all roles. Provider credentials: list `owner,admin,developer`; create/rotate `owner,admin` + fresh MFA proof (revoke proof-free); enablements `owner,admin`. Knowledge: uploads/complete `owner,admin,developer`; documents list/search + uploads-status all roles; slug-rename `owner,admin,developer`; memory decisions `owner,admin`. Connectors: link/sync/state `owner,admin,developer`; OAuth apps + dance `owner,admin` (callback public, rate-limited). Rollouts/releases: reads all roles (rollout rows surface paused_reason/by/at); writes `owner,admin`. Control blocks: `owner,admin` throughout. Analytics reads include billing. Full paths live in the controllers cited in References; this table pins the role split the UI gates on (server enforces regardless).

## 9. Error catalog (render verbatim, never generic-toast)

`slug_taken`/`source_slug_taken`/`owner_already_present`/`ownership_cap_reached` (409 + fix guidance); `unknown keys rejected: <dotted paths>` (422); `tool pins rejected: <name>: <reason>` (422); `allowed_models not present in the published model catalog` / `residency '<r>' not served` (422); `BLOCK — resolve the critical failures and re-evaluate` (+ required-checks variant); `schema_hash drift` (re-pin flow); `draft stale` (412 precondition_failed + expected/current hashes, merge-or-reload); `unresolved knowledge sources cannot publish: <slugs>` (422; map docs or acknowledged bypass via `acknowledge_degraded_knowledge: true`, audited as `assistant.publish_degraded_acknowledged`); seat/member caps + invite intact (retry, don't burn); step-up `step_up_required` → MFA modal → single retry.

## 10. Locked decisions (nothing open)

1. **Unresolved pins at publish: REFUSE (locked).** 422 with slugs unless `acknowledge_degraded_knowledge: true` (audited as `assistant.publish_degraded_acknowledged` from the committed snapshot). No warn-toast path — a silently context-less agent hallucinates.
2. **Operate UI: split (locked).** Emergency toggles (pause rollout + disable/kill) build now per §7; analytics/anomaly/variant sliders stay deferred. Template drift needs no engine work: drift UI reads installs.templateVersion + snapshot templateRef{slug,version,definition_hash} against the registry.

## 11. Explicitly out (with reason)

Cross-agent orchestration (would fork the run state machine); per-resource ACLs beyond document source-ACLs; SCIM/domain-claim (deal-gated); conversation-history auto-ingest (proposals stay explicit); provider conversation IDs as canonical; in-house model stack; white-glove implementation dependency (templates + test-runs ARE the onboarding).

## Acceptance (ship gate)

- [ ] Install → mapped knowledge (incl. connector doc via rename) → test-run → PASS eval → publish on a clean org, first session, no entitlements, zero errors.
- [ ] MISSING slugs, unresolved-pin refuse + acknowledged bypass (audited), BLOCK/WARN, drifted tool pins, unserved residency all render with fix paths.
- [ ] Disjoint-pin isolation (two agents, same query); restricted doc hidden from unmapped caller, visible after email-auto-link; retired doc unreachable; tombstone on source delete.
- [ ] Secrets never in responses/logs (grep-proven: fingerprints only, sealed blobs absent from list views, tokens body-only).
- [ ] Rollback restores exact prior behavior (pinned-run test); kill switch blocks acceptance within one run cycle; burn-rate pauses production rollout without auto-resume, and the paused rollout banners its reason (manual actor vs burn-rate costs); manual resume inside the cooldown suppresses re-pause once (no accumulator reset — ledger immutable), protection resumes after.
- [ ] Concurrent draft saves never clobber (stale hash gets 412 with both hashes; same-hash retry succeeds); discard removes DRAFT only; degraded bypass appears in audit with slugs.
- [ ] Caps pre-checked client-side; unknown keys 422 with paths; secret shapes rejected with field errors; multi-publish concurrency safe (advisory lock test); provider-credential create/rotate without fresh MFA proof gets step_up_required (revoke stays proof-free).

## References

- `engine/src/modules/assistants/{schema,validation.ts,dto.ts,assistants.{controller,service}.ts,templates.service.ts,manifest-resolution.service.ts,tool-catalog.*,model-catalog.*,provider-credentials.*,control-blocks.*,rollouts.*,releases.controller.ts,release-gate.ts,burn-rate.service.ts,residency.ts}` + `config-publish/payload-schemas.ts` (model catalog governance)
- `engine/src/modules/knowledge/{schema,connectors.schema,artifacts.service,ingestion.service,retrieval.service.ts:54-200,knowledge.controller,connectors.{controller,service},harness-parity.controller,analytics.query.service,eval.service}` + `workers/{analytics-rollup.consumer,template-provisioning.consumer}`
- `engine/src/modules/conversations/{schema,mcp-authority.service.ts (context assembly + SearchKnowledge),conversations.service.ts (run acceptance + manifests),escalations.{schema,service}}`
- `products/agent-studio/contracts/agent-definition/v1.schema.json` + `packages/agent-definition/{validator,compiler}` + `templates/registry.json` + `scripts/neryva-template-lint.ts`
- Research: Fin/Copilot/Agentforce/Sierra/Decagon/Kore.ai/Moveworks mappings (§2 of prior revision, retained in plan history).
