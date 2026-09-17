# Components — build order, status, and verified engine truth

> Parent doc: `agent_flow/main.md` (UX direction). Build plan: `docs/frontend/agent-creation-flow.md` §16.
> Rule: components are designed one at a time, in order. The builder page (`../builder/`) opens only when C01–C14 are signed off.
> Every "Engine binds" section below was re-verified against code on 2026-09-17. A component design that contradicts its binds is wrong — fix the design, never the binds. If code changed, re-verify and log it in "Corrections log".

## Order and status

| # | Component | Dir | Status |
|---|---|---|---|
| C01 | Identity (name, description) | `c01-identity/` | NOT STARTED |
| C02 | Instructions (directive composer) | `c02-instructions/` | NOT STARTED |
| C03 | Brand voice | `c03-brand/` | NOT STARTED |
| C04 | Brain (provider, model, fallback, params) | `c04-brain/` | NOT STARTED |
| C05 | Knowledge (uploads, pins, retrieval, coverage) | `c05-knowledge/` | NOT STARTED |
| C06 | Tools (catalog attach, approvals, drift, perimeter) | `c06-tools/` | NOT STARTED |
| C07 | Guardrails (policies, execution mode) | `c07-guardrails/` | NOT STARTED |
| C08 | Memory (scope, history, summarization; org治理 read-only) | `c08-memory/` | NOT STARTED |
| C09 | Budget (caps, cost preview, cache split) | `c09-budget/` | NOT STARTED |
| C10 | Evaluation (datasets, runs, decisions, shadow, drift) | `c10-evaluation/` | NOT STARTED |
| C11 | Templates (gallery, detail, install, updates) | `c11-templates/` | MODEL RESOLVED, design NOT STARTED |
| C12 | Origins (clone, import) | `c12-origins/` | NOT STARTED |
| C13 | Try (test-run, streaming, trace) | `c13-try/` | NOT STARTED |
| C14 | Ship (readiness, publish, success) | `c14-ship/` | NOT STARTED |
| C15 | Operate (versions, lineage, rollouts, health, audit) | `c15-operate/` | NOT STARTED |

## Per-component exit gate (all must hold before sign-off)

- Every label, state, limit, and error string traces to the component's Engine binds or a locked-doc decision. Nothing else ships.
- Empty, error, permission-denied, and conflict variants are all specified (no silent disables, no dead buttons, no generic toasts for typed errors).
- The exact engine read/write (route + role + payload keys) is named. No invented endpoints.
- `SPEC.md` status flipped to SIGNED OFF with date.

## Global contracts (apply to every component)

- Writes carry `Idempotency-Key: uuidv7`. Draft edits carry `If-Match: <hash>`; stale → **412** `{expected, current}` → merge-or-reload; same-hash retry succeeds (`assistants.controller.ts:135-157`, `assistants.service.ts:1966-1983`).
- Unknown payload keys → **422** with dotted paths, never silently stripped (`validation.ts:201-211`). Secret-shaped values/keys rejected before persistence (`validation.ts:128-155`).
- Roles: create/versions/test/evaluate/draft-edit = owner,admin,developer. Publish/rollback/retire/disable/delete/credentials-create = owner,admin. Reads = all roles incl. reader/billing where routed. Server enforces; UI explains.
- Statuses are dot + word, never color alone. Motion follows the token sheet (`design/_system/design_tokens.svg`).

## Corrections log (verified 2026-09-17 — old docs and early drafts were wrong here)

1. **Models per agent: 16, not 20.** Engine allows max 20 (`validation.ts:56`); contract caps 16 (`v1.schema.json`: `model_policy.allowed_models maxItems=16`). Tighter wins → builder enforces 16. Shape `provider/model` (`^[a-z0-9-]+/[a-z0-9._-]+$`).
2. **Tools per agent: 32, not 50.** Engine max 50 (`validation.ts:85`); contract max 32. Tighter wins → 32. Name: min **2** (contract; engine allows 1), max 64, `^[a-z0-9_]+$`.
3. **Gate refusals are 409, not 422.** BLOCK and required-checks refusals throw `ApiError.conflict` (`release-gate.ts:120-123`). UIs must render the message + fix path, not a validation form error.
4. **Registry holds 20 templates**, all `min_engine_schema: 2` (read directly from `products/agent-studio/templates/registry.json`). Gallery mock "24" is wrong.
5. **Two knowledge state machines, not one.** `upload_sessions` (UPPERCASE: CREATED→UPLOADING→UPLOADED→SCANNING→EXTRACTING→INDEXING→READY | QUARANTINED | FAILED) vs `documents.state` (lowercase: processing|ready|failed|retired). Designs must show the right machine per row.
6. **Model availability has exactly 3 engine reasons**: `provider_credential_missing`, `provider_not_enabled`, `residency_incompatible` (eu only) (`model-catalog.service.ts:211-237`). "Cost missing / rate limited / model disabled" are NOT engine reasons — render only if the UI derives them, labeled as such.
7. **Assistant name 2–128 chars**, unique per org (typed 409, never raw 23505); description ≤512 (`assistants.service.ts:1953`, `schema.ts:28-29,56`).
8. **`max_model_calls` minimum is 1, not 0** (`validation.ts:39`). A "disable model calls" control would fail validation.
9. **Knowledge pins: max 16 slugs**, kebab pattern (`v1.schema.json`: `knowledge_sources maxItems=16`). Engine side unbounded — contract binds the builder.
10. **Brand is first-class**, not a consumer note: ≤2000 chars, persisted on version + snapshot, hashed, composed into the served prompt (`validation.ts:48-52`). Hence C03 exists.
11. **Template compat codes are exactly 4**: `required_tool_missing`, `required_model_capability_missing`, `provider_credential_missing`, `knowledge_source_missing`; status COMPATIBLE/INCOMPATIBLE, advisory only (`templates.service.ts:399-470`).
14. **No-op publish is a 409, joint content+manifest**: `assistant active version already carries this payload` (`assistants.service.ts:1884-1889`). Same content + drifted manifest = legitimate re-publish; prompt-only edits always publish. Pre-empt with `No changes to publish`, never a surprise 409.
15. **Evaluate without dataset is a 422 with the fix**: `no template dataset for this assistant — install from a template or pass dataset_id explicitly` (`assistants.service.ts:1014-1024`). Hence Libraries → Datasets exists. Drafts ARE evaluable (synthesized snapshot, R-2).
16. **No knowledge "re-pin" action exists.** Publish auto-resolves slugs to current versions. Drift states are unresolvable-slug and coverage-incomplete only — any "Re-pin to latest" button would invent capability.
17. **Memory token uses `visibility`, not `retrieval_acl`** (`knowledge/schema.ts:205-237`). Scope enum: organization|conversation|assistant|user. Temporal + soft-delete columns all present (valid_from/invalid_at/supersedes/expires_at/deleted_at).
18. **Blocks split**: org control-blocks CRUD = owner/admin (manageable in UI); platform template-blocks = staff-written (read-only in UI). Never one write path for both.
19. **"Rolled back" is not a version status.** Enum: DRAFT…PUBLISHED…RETIRED. Rollback births a new version.
20. **"Pin" covers both**: knowledge slug-pins AND tool hash-pins (`assertToolPins`). Qualify (slug-pin vs hash-pin); `toolBindings` = the entries list.
12. **Tool-name leading-letter rule is UNVERIFIED.** Contract requires only `^[a-z0-9_]+$` (min 2). The `^[a-z]…` variant in older docs must not be enforced until proven. Open item for C06.
13. **Memory `user` scope is UNRESOLVED.** Engine enum + default is `user` (`validation.ts:63-66`); older docs say the consumer omits it. Resolve in C08 before designing the scope control.
