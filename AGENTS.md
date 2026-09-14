# AGENTS.md — Neryva Engine

> **Engine = control plane and system of record. Agent Studio = execution plane. LLM = reasoning engine.**
> Every durable business fact has one owner, one lifecycle, and one recovery path. Read this file before any code change.

## Commands

```bash
# Install (pnpm is canonical; npm works for read-only)
pnpm install           # or npm ci

# Build / typecheck / lint — run before every commit
pnpm run build         # tsc -p tsconfig.json → dist/
pnpm run typecheck     # tsc --noEmit (strict)
pnpm run lint          # eslint src

# Dev (watches dist/main.js with .env)
pnpm run dev

# Database — migrations are ordered, reviewed, immutable after merge
pnpm run migrate:generate   # drizzle-kit generate (review SQL before commit)
pnpm run migrate            # drizzle-kit migrate (release job only, never per-replica)

# Single-file test (fastest feedback — requires Phase 0.4 toolchain)
pnpm test -- path/to/file.test.ts          # planned: vitest (ledger 0.4 adds vitest + scripts)
pnpm vitest run -t "<test name>"            # alternative direct invocation after 0.4

# Full suites (planned — ledger 0.4; do NOT invent flags before they exist)
pnpm test:unit                              # planned
pnpm test:integration                       # planned
pnpm test:contract                          # planned
pnpm test:isolation                         # planned
pnpm test:property                          # planned
pnpm test:chaos                             # planned
pnpm test:load                              # planned
```

If a command fails, fix it before writing code. Do **not** guess flags — read `package.json:9-16` and `opencode.json`.

## Project Structure

```
engine/
├── src/
│   ├── app.module.ts            # assembly only — flag-gated imports, APP_GUARD order
│   ├── main.ts                  # Fastify bootstrap, OTel first, bijection check
│   ├── tracing.ts               # OTel SDK (traces only; metrics = Prometheus)
│   ├── common/                  # kernel: config, db, auth, audit, observability, http
│   │   ├── config/env.ts       # typed immutable env, fail-closed in production
│   │   ├── config/feature-flags.ts  # ModuleFlags + validateFlagMatrix()
│   │   ├── infra/db/db.service.ts   # withOrg/withBypass, RLS tenant context
│   │   ├── auth/auth.guard.ts   # L1 JWT / L2 nrv_live_ / L3 service
│   │   └── audit/audit.service.ts   # hash-chained, byte-identical to Python
│   └── modules/                 # 14 feature modules, each behind one flag
│       ├── identity/            # accounts, OIDC, sessions, social
│       ├── organizations/       # orgs, memberships, projects, entitlements
│       ├── billing/             # spend_events, invoices, price_catalog, Stripe
│       ├── studio-furniture/    # project-key binding furniture only (studio_project_keys) — NOT the Studio runtime, see Canonical locations below
│       ├── assistants/          # assistants, assistant_versions, policy_snapshots (Phase 3)
│       ├── conversations/       # conversations, messages, runs, run_events (Phase 4)
│       ├── channels/            # channel plane: Messenger/WhatsApp/Telegram webhooks, website widget, senders (Phase C)
│       ├── deployment/          # product_deployment schema, envelope encryption
│       ├── config-publish/      # published_configs/config_drafts — exemplar for immutable publish
│       ├── satellites/          # fleet + revocation feed
│       ├── keys/, webhooks/, notifications/, staff/, corporate/, console/
├── drizzle/                     # 0001–0023 SQL — engine-ts owned only
├── drizzle.config.ts            # schema = engine-owned files only (ownership-map.json)
├── ownership-map.json           # canonical owner map (engine-ts vs python vs shared)
├── products_manifests/          # agent_studio.yaml, deployment.yaml, inference.yaml
├── docs/architecture/engine/    # authoritative specs + imp/ledger.md tracker
│   ├── engine_architecture.md
│   ├── engine_data_and_lifecycle.md
│   ├── engine_implementation_plan.md
│   └── imp/ledger.md            # phase-gated task ledger — single source for order
├── ../products/neryva_mcp/      # Neryva MCP contract (neryva.mcp.v1 proto) — consume, do not copy (sibling of engine/)
└── ops/                         # compose, dashboards, runbooks (to be added)
```

Use `Read` on `docs/architecture/engine/imp/ledger.md:1` to find the current phase and task ID. That ledger is the execution order; this file is the daily operating contract.

## Implementation Status (2026-09-01 — do not hallucinate)

- **Engine:** Phases 0–2 hardened. **Phase 3 code complete** — `assistants`/`assistant_versions`/`policy_snapshots` (`drizzle/0020`/`0021`), immutable publish + snapshot-in-publish-TX + no-op guard + deterministic export/import; legacy module renamed to `src/modules/studio-furniture` (env flag keeps the old name). **Phase 4 code complete** — `conversations`/`conversation_participants`/`messages`/`runs`/`run_events` (`drizzle/0022`) + `outbox_events`/`inbox_events`/`idempotency_records` (`drizzle/0023`, DB idempotency tier pulled forward from 6.7); start-message TX and `commitRunResult` atomic commit implemented in `src/modules/conversations/`. Exit gates for Phases 3–4 are **pending the first full CI/DB run** — do not mark ledger boxes `DONE` until then. Pinned decisions live in `docs/architecture/engine/imp/ledger.md` (Phase 3.1 + Phase 4 header): outbox machine `PENDING→CLAIMED→PUBLISHED→RETRY_WAIT→DEAD_LETTER`; run terminal state is `COMPLETED`; lease columns live on the `runs` row (no `run_leases` table); contract package is `@neryva/mcp-contract` (singular). **Phase 5 code complete** — MCP authority host over ConnectRPC (`src/transport/mcp/`, `MODULES__MCP_ENABLED`), Engine consumes `@neryva/mcp-contract` (file: dep; services from the `*_pb` GenService definitions), run-scoped HS256 capability tokens (`MCP_CAPABILITY_SIGNING_KEY`, fail-closed in production), lease CAS / AppendRunEvents dedup / approvals / memory proposals / tool effects / checkpoints (`drizzle/0024_mcp_authority.sql`). Deferred: mTLS/SPIFFE workload identities, `GetRunArtifact` (Phase 7), usage entry in CommitRunResult (Phase 8), RuntimeControl dispatch (Phase 6). **Phase 6 code complete** — generic outbox dispatcher (`src/common/infra/outbox/dispatcher.ts`, `FOR UPDATE SKIP LOCKED`, backoff+jitter, dead-letter + operator replay, stale-claim recovery `drizzle/0025`), inbox-dedup consumer contract (`consumer.ts`), worker host (`src/workers/`, `WORKERS__OUTBOX_ENABLED`), first consumer delivers `StartRun` to Studio via `RuntimeControlService` when `NERYVA_RUNTIME_BASE_URL` is set (skip = run stays ACCEPTED); EventBus is hints-only (6.8). **Phase 7 code complete** — knowledge plane (drizzle/0026, src/modules/knowledge/, MODULES__KNOWLEDGE_ENABLED): upload sessions with sha256-bound presigned POSTs + headObject verification, ingestion worker (SCANNING→EXTRACTING→INDEXING→READY, resume-safe), pgvector retrieval with ACL-before-scoring (EMBEDDING_PROVIDER=local is a documented non-semantic dev/test hash), memory_items promoted from approved MCP proposals, and the MCP GetRunArtifact claim-check facade (7 fresh checks). **Phases 8–10 code complete** — Phase 8: immutable usage_ledger_entries + compensating corrections, durable quota reservations (RESERVED→COMMITTED→RELEASED), reconciliation pass, billing webhook inbox wired into the Stripe controller, usage consumer over the outbox (drizzle/0027). Phase 9: retention policies, legal holds (block purge), ordered+resumable purge workflow to tombstones, one-time export downloads, data_access_records stream (drizzle/0028, src/modules/lifecycle/). Phase 10: ASVS mapping, SLOs, runbooks, CI (pgvector migration smoke); live-environment drills (red-team, PITR/restore, rotation) remain open. **All DB-backed exit gates for Phases 3–10 await the single full run** (compose up + migrate + pnpm test:integration / test:isolation). **Channel plane (Phase C) code complete** — external messaging transports onto the conversation plane (`drizzle/0030_channels.sql`, `src/modules/channels/`, `MODULES__CHANNELS_ENABLED`): channel_accounts CRUD with envelope-sealed credentials (`enc:v1:`) and entitlement-capped; public webhook plane `/webhooks/channels/:platform/:accountId` (Meta `hub.challenge` + `X-Hub-Signature-256` over the raw body, Telegram `X-Telegram-Bot-Api-Secret-Token`) with durable `channel_events` ingest (dedup before side effects) feeding the ONE `acceptMessage` entry point; outbox consumer `channel-outbound` delivers `run.completed`/`run.failed` replies per platform with the Meta 24h messaging-window policy (template/note out-of-window) and per-account send-rate limits, claim-before-send via `channel_message_links` unique(message_id); website widget plane (`/public/channels/:publicKey/*`) with `nk_live_` public keys, hash-at-rest sessions, Origin allowlist, per-session hourly caps, session-scoped SSE + messages; plan: `docs/architecture/engine/channel_integrations_plan.md`, runbook: `ops/runbooks/channel-operations.md`. Phase C DB-backed exit gates (webhook replay idempotency, signature-forgery negatives, double-send redelivery, cross-origin widget denial) join the first full CI/DB run.
- **Harness context supply chain (2026-09-12) code complete** — contract `@neryva/mcp-contract@0.2.1` (v1.1 additive: ContextManifest.instructions/model_params/allowed_models, ToolDescriptor.input_schema_json+annotations, MemoryRef.content, KnowledgeRef.snippet+source ranges, RunBudgets token/cost/wall-clock, RunAuthorityService +`SearchKnowledge` +`SaveConversationSummary`, CommitRunResult.usage) with Engine side fully wired: migrations `0031`–`0035` (assistant instructions+model_params, `tool_catalog`, `conversation_summaries`+title, `message_feedback`, MESSAGE_ATTACHMENT/GENERATED_MEDIA purposes), assistant schema v2 (`instructions` required at publish, `assertToolPins` schema-hash pinning), tool-catalog module (`src/modules/assistants/tool-catalog.*`), real `GetAuthorizedRunContext` assembly (snapshot instructions/params, compaction summaries, approved memory CONTENT, ACL-before-scoring knowledge retrieval, catalog tool schemas, budgets — untrusted content spotlighted + PII-redacted via `src/common/guardrails/`), `SearchKnowledge`/`SaveConversationSummary` RPCs (capability op `search_knowledge`), usage ledger entry written in the CommitRunResult TX, feedback/title routes, SSE `delta` event name for assistant chunks. DB-backed exit gates still await the first full CI/DB run — no ledger boxes checked.
- **Agent template plane (2026-09-13) code complete + reviewed** — per `docs/dev/agent_related/_agent_setup_detail_plan.md` (design authority) and `agent_setup_ledger.md` (TPL-0…TPL-10; 37/44 CODE_COMPLETE): migrations `0048` (global `assistant_templates` registry + RLS `assistant_installs` — schema only, rows arrive via the `templates:sync` release-job upsert of `registry.json`, never DDL) and `0049` (snapshot `tool_bindings`/`knowledge_pins`/`model_ref`/`template_ref`/`manifest_hash`, RLS `run_manifests` written in the run-acceptance TX at accept/regenerate/edit, `eval_runs` provenance/`decision` PASS|WARN|BLOCK, rollouts `environment`+`channel` release pointers, assistant kill flag, RLS `control_blocks`); `TemplatesService` (list with compatibility reasons, get, install = one-TX copy + provisioning outbox, checkUpdates), `ManifestResolutionService` (publish-TX ToolBinding/knowledge-pin/model/template resolution), `ControlBlocksService` (CRUD + five-level kill enforced at run acceptance, `authorizeToolCall`, context assembly, `GetToolCredential`, release-pointer assignment, template install), publish-TX BLOCK gate (latest-decision-wins), `search_knowledge`/`search_memory` joined `BUILT_IN_TOOLS`, deep unknown-key 422 (`rejectUnknownPayloadKeys` in validation.ts, enforced at create/install/sync), eval gate + provenance + regression bound in `EvalService.completeRun`, candidate promote/reject observe loop, channel-plane template binding enforcement (`ChannelsService.assertAssistantRoutable`), 20 Tier-1+Tier-2 BOMs + `registry.json` + generator + `neryva-template` lint in `../products/agent-studio/templates/`. Independent review pass fixed: semver downgrade-as-update bug, `CHANNEL_TO_PLATFORM` key reversal, WorkersModule `@Optional()` consumer drop (missing Billing/Webhooks imports), nested-key silent stripping, dead channel-addressable releases, per-template org-fact N+1. Still open: TPL-3.4 (CI job for `templates:lint`), TPL-5.7 golden fixture, TPL-10 exit gates — await the first authorized full CI/DB run.
- **Neryva MCP:** **100% complete end-to-end** in `../products/neryva_mcp/` (`neryva-mcp-contract/proto`, `gen/ts`, `tests`, `buf lint/breaking/generate`) — do NOT reimplement; Engine consumes generated types via `@neryva/mcp-contract` in ledger Phase 5.
- **Release gap report (2026-09-13) FINAL** — \docs/dev/agent_related/release_readiness/release_gap_report.md\ is the binding register. Closed during finalization: POSIX \ile:\ contract dep, CI checkout guard + \db-suites\ job (now required, \ci.yml:176\), 7/7 runbooks, dead code. Execution order: elease_ledger.md\ (**0 TODO / 62 CODE_COMPLETE** — ninth pass 2026-09-14, Wave 3 activated). Engine — governance→execution→money→operate chain (REL-1..11); Studio — \EngineSecretProvider\ GAP-01/02 closed end-to-end. All authorable surface closed: F1 invoice derivation + F2 agents markers, residency second region \eu\, BYOK \credential_source\, burn-rate auto-rollback, advanced approvals (drizzle/0056). Remaining: DONE requires first full CI/DB run + evidence propagation (REL-0.9).
- **Agent Studio:** canonical runtime is `../products/agent-studio/` (TypeScript + Temporal execution plane, DONE alongside Engine + MCP). `src/modules/studio-furniture` is project-key binding furniture only (`studio_project_keys` `drizzle/0006`), not the runtime. Do NOT add runtime logic to Engine.

## Code Style

- **TypeScript strict mode** (`tsconfig.json:9`). No `any`. `strictPropertyInitialization: false` is the only relaxed flag — do not widen it.
- **NestJS + FastifyAdapter** (`src/main.ts:30`). Keep handlers thin; domain logic in `modules/*`, cross-cutting in `common/*`.
- **Drizzle ORM** is the SQL builder (`drizzle-orm`). Keep SQL visible: reviewed migrations, explicit locks, no generic repository hiding transactions.
- **Named exports only.** No default exports (except `main.ts` bootstrap and NestJS modules).
- **Async/await** only. No `.then()` chains.
- **Error messages:** lowercase, no trailing period, stable `code` + HTTP status + retryability in `src/common/http/api-error.ts`.
- **IDs:** opaque `uuidv7` for new tables (time-sortable); existing `gen_random_uuid()` (v4) stays. Never expose DB sequences as API IDs.
- **Timestamps:** UTC `timestamptz` as canonical; keep µs as string via `src/common/infra/db/pg-types.ts` for chain hashing.
- **Do NOT** put prompts, tokens, credentials, raw documents, or provider responses in PostgreSQL rows, NATS/Temporal payloads, or logs.

## Architecture — Non-Negotiable Invariants

These 12 decisions **must not be weakened** (`engine_architecture.md:570`):

1. Engine is system of record for customer-facing business data.
2. Agent Studio has no direct DB credentials.
3. Every tenant-owned query and object access carries `organization_id` (RLS + app predicate + tenant-bound object key).
4. Every externally retried command has idempotency (`organization_id + principal_id + endpoint_family + idempotency_key` → DB `idempotency_records` + domain uniqueness).
5. Every published assistant version is immutable.
6. Every side effect has durable outcome or reconciliation path.
7. Outbox is written in **same transaction** as the fact it announces.
8. Durable semantic events separate from ephemeral token streaming.
9. Audit/billing is append-oriented with compensating entries, never rewritten.
10. Large/sensitive payloads use claim-check `ArtifactRef` (7 facade checks), not unbounded transport.
11. Deletion/retention/export/legal-hold are first-class workflows.
12. Frameworks are replaceable adapters, not business truth.

Additional:

- **Canonical locations (final):** Neryva MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`, `neryva.mcp.v1`); Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane); Frontend = `../console/neryva-website/` (`neryva-website`, Vite React console, sole entry in `console/`, UI `/agent-studio/*`). `src/modules/studio-furniture` is project-key binding furniture only (`studio_project_keys` binding, `drizzle/0006`). It is **not** the `assistants`/`conversations`/`runs` domain. Do not add new conversation/run logic there — create `src/modules/assistants/` and `src/modules/conversations/` per ledger Phase 3–4. Ledger 3.7 rename is DONE.
- **Neryva MCP** contract is authoritative in `../products/neryva_mcp/neryva-mcp-contract` (sibling of `engine/`). Import generated types; never hand-copy wire objects.
- **Tenant isolation:** `DbService.withOrg(orgId)` (`src/common/infra/db/db.service.ts:54`) sets `app.current_tenant` transaction-local; `withBypass` is narrow and audited. RLS is `ENABLE + FORCE` with `USING (org_id = current_setting('app.current_tenant',true) OR app.engine_bypass)` (`drizzle/0002_org_furniture.sql:68` pattern). New tenant tables must follow this exact pattern with tests for `application` / `worker` / `owner` / `BYPASSRLS`.
- **Idempotency:** Tiered — Redis ephemeral lease (`idem:principal:key` `src/common/http/idempotency.ts:54`) + DB authority. Same key + same hash replays; same key + different hash is `409 conflict`.
- **Outbox:** Transactional `PENDING→CLAIMED→PUBLISHED→RETRY_WAIT→DEAD_LETTER` + `inbox_events (consumer+event_id)` — dispatcher polls `FOR UPDATE SKIP LOCKED` (`engine_data_and_lifecycle.md:219`).

## Testing

- **Unit** — domain transitions, validators, entitlement math, idempotency, cursors. No network.
- **Integration** — real PostgreSQL + MinIO + Redis/Valkey (+ Temporal/NATS when added). Test migrations, RLS, locks, signed URLs, TX rollback.
- **Contract** — OpenAPI schema compatibility, Neryva MCP generated client/server interop, event `unknown-field` tolerance.
- **Isolation** — two orgs × multiple roles; every route/worker/cache key/object prefix/search query must deny cross-tenant.
- **Property / concurrency** — duplicate/reordered delivery, concurrent publish/message/cancel, lease fencing, ledger compensation.
- **Chaos / failure** — `kill -9` after each durable boundary, broker redelivery, degraded object storage/provider/cache/IdP.
- **Load** — tenant-skewed, long conversations, stream reconnects, ingestion throughput.

Run the **single-file** command first, then the phase-specific suite. Store p50/p95/p99 with each benchmark.

## Verification Gates (Definition of Done excerpt)

Before declaring a task done (`engine_implementation_plan.md:10` + `imp/ledger.md:664`):

- [ ] RLS + app predicate negative tests pass for every tenant-owned table (including `assistants`/`conversations`/`runs`/`run_events` once introduced).
- [ ] User message acceptance + run creation + outbox publication are one atomic PostgreSQL transaction.
- [ ] Duplicate API / broker redelivery / worker retry cannot duplicate user-visible messages or billable effects.
- [ ] `EXPLAIN` plans exist for list/lookup/auth/event/message queries; no route serializes a DB row directly.
- [ ] No prompt / token / credential / raw document in logs, traces, Temporal history, or frontend events (redaction denylist in `src/common/observability/logger.ts`).
- [ ] Migration is ordered, reviewed, immutable after merge, single release-job applied, with `ownership-map.json` entry (`engine-ts`) and expand/contract notes if destructive.

If any box is unchecked, the task is **not done** — regardless of demo success.

## External File Loading

Use lazy loading. Do **not** preemptively read all references.

- For type-safe DB / env / feature-flag details: `src/common/infra/db/db.service.ts`, `src/common/config/env.ts`, `src/common/config/feature-flags.ts`
- For tenancy / entitlements / guards: `src/modules/organizations/*`, `src/common/auth/*`
- For publish pattern reference: `src/modules/config-publish/config-publish.service.ts`
- For Neryva MCP shape: `../products/neryva_mcp/neryva-mcp-contract/proto/neryva/mcp/**` (sibling of `engine/`)
- For delivery order: `docs/architecture/engine/imp/ledger.md:1` (Phase + task ID required in every PR description)

When a doc references `@docs/architecture/...`, use your `Read` tool on that path only if the current task needs it.

## Security

- No secrets in repo: `.env` is gitignored; `ENGINE_ENCRYPTION_KEY`, `IDENTITY_JWT_SIGNING_KEY_FILE`, `IDENTITY_COOKIE_KEYS` must fail-closed if missing in production (`src/common/config/env.ts:192`).
- HttpOnly, SameSite, CSRF-protected cookies for same-origin browser sessions; `Authorization: Bearer` for service/L2 (`src/common/auth/*`).
- Signed URLs: tenant-bound key (`org/{orgId}/...`), exact method/length/checksum, short TTL, validated server-side. Object keys never use user-supplied filenames.
- Every privileged decision writes an audit record (`src/common/audit/audit.service.ts`) with actor, scope, reason, policy version, trace ID — protected from Studio mutation.

## PR Hygiene

- One task ID per PR — reference ledger ID (e.g., `1.4`, `3.1`, `4.7`) in title and description.
- Migrations: include `drizzle/00NN_*.sql` + `drizzle/meta/_journal.json` bump + `ownership-map.json` delta. Mark destructive steps with rollback/forward-fix plan.
- Tests: accompany code — at least unit + isolation for new tenant surface, contract for new RPC, property for new state machine.
- Docs: update `AGENTS.md` or `imp/ledger.md` in the same PR that changes the convention.
- Never edit generated Protobuf / OpenAPI clients by hand — they are build artifacts.

## When Stuck

- Architecture conflict → `docs/architecture/main.md:237` (Engine–Studio boundary) then `docs/architecture/engine/decisions/*.md`.
- Transaction / RLS doubt → `engine_data_and_lifecycle.md:430` consistency summary + `engine_architecture.md:263` tenancy model.
- Identity / staff / membership design → `docs/dev/auth_plan.md` (design authority, D1–D6) + `docs/dev/auth_ledger.md` (AUTH-x.y execution order); end-user boundary in `decisions/adr-014-enduser-identity-boundary.md`.
- Agent template / setup design → `docs/dev/agent_related/_agent_setup_detail_plan.md` (design authority) + `docs/dev/agent_related/agent_setup_ledger.md` (TPL-x.y execution order, Phase 3.x expansion).
- Skill-specific procedure → call `skill({ name: "<skill-name>" })` — see `opencode.json:skills` and `.agents/skills/*/SKILL.md`.

This file is committed to Git. Other contributors and CI rely on it. Keep it under 500 lines; link to detailed specs instead of inlining them.
