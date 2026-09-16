# Neryva Frontend Implementation Plan — Agent Studio Console

> Status: spec DONE 2026-09-15 (build pending M0→M6; residual safety round fa947e3 landed: draft OCC, pin-refuse gate, burn cooldown, knowledge-health).
> Owner: Frontend team + Engine platform team.
> Scope: **the console/product UI only** — `console/neryva-website` wired to Engine authority APIs, plus the static SaaS pages that already exist. How the organization-facing Agent Studio product (assistants, templates, knowledge, conversations/runs, approvals, usage/billing, audit, lifecycle) is built as an enterprise-grade console.
> Non-goals of this doc: changing Engine tenancy/RLS, billing math, the MCP wire contract, or the Studio runtime. Those stay as specified in `docs/architecture/engine/*`, `docs/architecture/neryva_mcp/*`, and `products/agent-studio`.
> Companion: Engine ledger `docs/architecture/engine/imp/ledger.md` (system gates), agent-setup detail `docs/dev/agent_related/_agent_setup_detail_plan.md` (system gaps the UI must close, not re-specify).
> Verification: codebase citations re-checked against `engine/src` + `console/neryva-website/src` + `products/agent-studio` on 2026-09-15. Paths below are repo-root-relative (`neryva_studio/`); Engine files appear as `engine/src/...`, website files as `console/neryva-website/src/...`.
> Rule: no phase may be marked `DONE` without its exit-gate evidence (typecheck + lint + unit/vitest + contract check against the composed Engine OpenAPI + manual QA script result).

---

## 0. Controlling invariants (read first)

1. **The browser is never authoritative.** Engine owns identity, tenancy, authorization, canonical history, billing truth, and audit. The console renders Engine state and issues Engine commands; it never invents IDs, versions, entitlements, or usage figures.
2. **OAuth-only authentication.** The console authenticates exclusively through the Engine's OIDC provider (Authorization Code + PKCE, `S256`), including social login (Google/Microsoft/GitHub/Apple) via Engine's `/login/:uid/social/:provider` handshake. No local password form, no OTP form, no password-reset/email-verification UI, no tokens in `localStorage`. This removes the entire verification surface (email codes, reset tokens, enumeration resistance) by delegating it to the Engine/IdP.
3. **Agent Studio runtime stays headless.** Canonical runtime is `products/agent-studio/` (Temporal + TS). The console never imports provider SDKs, never calls Studio `runtime-control` directly, never opens Temporal, never holds provider credentials. Run observation goes through Engine SSE (`engine_sequence` cursors); run control goes through Engine console/L2 endpoints.
4. **Neryva MCP is not a browser protocol.** The browser never sees `neryva.mcp.v1`, capability tokens, or lease epochs. It sees Engine REST/JSON + SSE only.
5. **Every write is safe to retry.** Mutations send `Idempotency-Key` (uuidv7); the UI treats 409-conflict and `idempotent-replay` as normal, not errors. Destructive/money/credential acts additionally pass a fresh `X-MFA-Proof` via the step-up modal.
6. **What the server denies, the UI hides — but the server decides.** Role × entitlement gating (`capabilities.ts`) disables/hides actions client-side; Engine guards (`OrgRolesGuard`, `EntitlementGuard`, `StepUpGuard`) remain the enforcement point. A hidden button is UX, never a security boundary.

---

## 1. Current state (factual, 2026-09-15 — what we keep vs fix)

### 1.1 The site is two products in one shell (keep this split)

`console/neryva-website` (`neryva-website@0.0.0`, Vite + React 18 + TanStack Router + TanStack Query + zustand — `console/neryva-website/package.json:2-34`) renders through one root (`src/router/root.tsx:37-62`): marketing pages get `<Header/><Footer/>`, while `/agent-studio`, `/deployment`, `/platform` (`APP_SHELL_PATHS`, `root.tsx:37`) render app chrome instead.

| Part | Location | State |
|---|---|---|
| **Static SaaS pages** | `src/pages/{home,research,resources,company,contact,products,solutions,secret,auth}` + content JSON in `src/neryva_data/**` (aliased `@neryva_data`, `vite.config.ts:27`) + adapters in `src/lib/data/*` | **Correct as-is.** Content-driven marketing; keep JSON-fed rendering. No Engine dependency except forms (contact/newsletter/careers). |
| **Platform shell** (org admin) | `src/pages/platform/*` (`PlatformShell`, members/projects/api-keys/usage/billing/audit/settings/status) + `src/lib/engine/*` client | **Partially wired.** Keep and complete — the Studio console depends on org context, keys, billing, and audit that live here. |
| **Agent Studio shell** | `src/pages/products/agent_studio/*` + views in `src/sections/pages/products/agent-studio/*` + hooks in `src/hooks/studio/*` (21 files) | **Mixed.** Shell, chat (SSE), agents CRUD/publish/rollback/retire, teams, compliance lifecycle, and settings tabs already call Engine (`AgentsView.tsx:367`, `AgentDetailView.tsx:476,388,518`, `useChat.ts:290-367`, `TeamsView.tsx`, `ComplianceView.tsx`, settings tabs). **Gaps are known and listed in §5** (notably `TemplatesView.tsx:157` toast-only install, `EvaluationsView.tsx:70` toast-only queue). |
| **Deployment shell** | `src/pages/products/deployment/*` + `src/sections/pages/products/deployment/*` | **Mock-only (toast-driven). Deferred per directive** — see §9. Hide from nav; do not wire until its Engine surface is declared ready. |

### 1.2 Auth today is dual-stack (fix to OAuth-only)

Two session systems coexist:

- **(A) Legacy marketing backend** — `src/api/*` (axios, `API_BASE_URL` = `/api/v1` dev / `https://neryva-backend.vercel.app/api/v1` prod, `src/api/index.ts:4-12`) with email/password/OTP/reset (`authApi.ts:14-106`), Bearer injection from `useAuthStore` (`src/api/index.ts:44-50`), tokens persisted in `localStorage`/`sessionStorage` (`src/store/authStore.ts:36-70`). Dev interceptor blocks everything except `/contact/` (`ERR_DEV_BLOCKED`, `src/api/index.ts:31-42`).
- **(B) Engine OP session** — `src/lib/engine/{client,auth,sse,session-gate,errors,capabilities,stepup}.ts`: Authorization Code + PKCE against pre-registered `neryva-console` (`auth.ts:1-17`), access token memory-only, refresh in `sessionStorage` (`auth.ts:44-52`), `credentials: 'include'` same-origin via `/engine` proxy (`client.ts:16-24`, `vite.config.ts:41-45`), org in `X-Neryva-Org` (`client.ts:150-153`), SSE with `Last-Event-ID` replay (`sse.ts`), role × entitlement matrix (`capabilities.ts`), step-up proofs (`stepup.ts`).

Engine side already supports everything (B) needs: first-party OP with PKCE-S256-only and no implicit/ROPC (`engine/src/modules/identity/oidc/oidc-provider.factory.ts:10,68-71`), seeded `neryva-console` public client with callback `${ENGINE_BASE_URL}/platform/auth/callback` (`engine/src/modules/identity/identity.module.ts:98-132`), social handshake with single-use state/nonce/PKCE (`engine/src/modules/identity/social/social-login.service.ts:17-20,48-78`; Google/Microsoft PKCE, GitHub/Apple state+nonce — `social.config.ts:25-26,44-89`), JWKS rotation with overlap (`jwks-custody.ts:6-12,40-60`), and fail-closed prod key/HTTPS checks (`env.ts:354-358,392-402`).

Notably the OAuth-capable pieces in the website already exist but are **bypassed for testing**: `hydrate()` injects `dev-dummy-access-token` (`auth.ts:53-66`), `SessionGate` returns children unconditionally (`src/components/platform/SessionGate.tsx:13-15`), `requireEngineSession()` returns immediately (`session-gate.ts:19-22`). Phase 0 removes all three bypasses.

### 1.3 Engine API surface the console consumes (no new endpoints proposed)

Full inventory was taken 2026-09-15 (controller file + line for every route). Summary for planning — details live in the inventory, cited per feature in §4:

- Org context: `:orgId` param everywhere; `X-Neryva-Org` only for `GET /console/home`, `GET /console/onboarding`, and `OrgRolesGuard` fallback (`engine/src/common/policy/org-roles.guard.ts:38-44`). L2 derives org from the key (`conversations.public.controller.ts:28-30`).
- Assistants + versions + publish/rollback/retire/import/export/snapshot/provenance + test-runs + evaluate (`assistants.controller.ts:15-269`); templates list/get, install via `POST .../assistants {template}` (`templates.controller.ts:18-26`, `assistants.controller.ts:19-29`); rollout + releases pointers (`rollouts.controller.ts`, `releases.controller.ts`); control-blocks + staff fleet (`control-blocks.controller.ts`, `fleet.staff.controller.ts`).
- Tool catalog + from-template, model catalog (+reasons), provider credentials (fingerprints-only list, BYOK create/rotate/revoke, provider enablements) (`tool-catalog.controller.ts`, `model-catalog.controller.ts`, `provider-credentials.controller.ts`).
- Knowledge: uploads (presigned POST flow), documents search (`limit` clamp 1–20), memories + proposal decisions, connectors, eval datasets/cases/runs/results/promote/reject/recall, analytics rollups (`knowledge.controller.ts`, `connectors.controller.ts`, `harness-parity.controller.ts`).
- Conversations/runs/events: cursor pagination (`after`/`after_sequence` + `limit` → `next_cursor`), three SSE streams with `engine_sequence` replay (`conversations.controller.ts:337`, `conversations.public.controller.ts:90`, `channels/widget.controller.ts:215`), approvals + escalations queues.
- Money/compliance: usage overview/series/rollup, billing ledgers/invoices/credits/budgets/adjustments/usage-export, audit list/facets/export/verify, lifecycle retention/purge/holds/exports/tombstones, webhooks, notifications, onboarding/limits/status/home.
- Writes are `@Idempotent()` unless noted (notably absent: assistant DELETE/retire, keys revoke, webhook update/rotate/test, invoice issue/pay/void, budget delete, message-accept uses DB-tier `dto.idempotency_key` instead). The UI must generate keys for **all** mutating calls regardless of decorator presence (server treats unknown keys as new — safe).

---

## 2. Architecture decision: what lives where

```
console/neryva-website
├── marketing (public, no session)     # /, /research, /resources/*, /company/*,
│                                      # /solutions, /products/*, /contact, /secret
│                                      # → neryva_data JSON + forms only
├── /platform (org admin, L1)          # home, organization/members, projects,
│                                      # api-keys, usage, billing, audit,
│                                      # settings, status  → engine() console APIs
├── /agent-studio (product, L1)        # §4 feature map  → engine() console APIs + SSE
└── /deployment (DORMANT)              # hidden from nav until Engine declares ready — §9
```

- **Keep** the single TanStack Router tree and three-shell layout (`root.tsx`, `routes.tsx`). No framework migration.
- **Keep** `src/lib/engine/client.ts` as the **sole** Engine transport (`engine<T>()` + `engineDownload()` + `authorizationHeader()` for SSE). Delete the parallel auth path in `src/api/*` (§3).
- **Keep** `src/lib/engine/sse.ts` + `useEventStream` as the **sole** streaming transport (fetch-based: native `EventSource` cannot send `Authorization` — `sse.ts:5`). No new streaming lib.
- **Keep** `capabilities.ts`, `errors.ts`, `stepup.ts` as the policy/UX layer; extend, don't replace.
- **Keep** `neryva_data` for marketing content only. App views must never import `@neryva_data/products/agent_studio/*` as data (nav skeleton already does — `AgentStudioShell.tsx:73-77`; migrate shell nav to a static TS constant in Phase 1 and cut the import).
- **No widget/embed work in this plan.** Engine's website-widget plane (`public/channels`, `nk_live_`, `widget.controller.ts`) is a separate frontend track; the console must not depend on it.

---

## 3. Auth migration: OAuth-only (Phase 0 — blocks everything else)

### 3.1 Target flow (all pieces exist Engine-side)

```text
1. Anonymous user hits /agent-studio/* or /platform/*
   → beforeLoad requireEngineSession() (RE-ENABLED) → beginLogin()
2. beginLogin() stashes return path + PKCE verifier/state (sessionStorage)
   → location.assign(ENGINE /auth?client_id=neryva-console…)
3. Engine OP interaction: user picks a social provider
   → GET /login/:uid/social/:provider → IdP → GET /login/social/callback/:provider
   → Engine session issued (email-code/password interaction paths untouched —
     they exist server-side but the console never links to them)
4. OP redirects to /platform/auth/callback?code&state
   → handleAuthCallback() validates code/state/verifier → token grant
   → applyTokens (access in memory, refresh in sessionStorage)
   → navigate to stashed return target (in-app only, else /platform)
5. Authenticated: engine() attaches Bearer (memory-first, single-flight 401
   refresh), X-Neryva-Org from OrgProvider, Idempotency-Key per mutation,
   X-MFA-Proof passthrough; proactive refresh ~60s pre-expiry (auth.ts:89-100)
6. Logout → Engine end_session + local clear (auth.ts:206-215)
```

Configuration is two values only: `VITE_ENGINE_URL` (non-standard topologies; default same-origin `/engine` proxy so OP cookies stay first-party — `client.ts:16-21`) and the pre-registered `neryva-console` client id/scopes (`openid email profile offline_access`, `auth.ts:1-17`). No secrets in the bundle — public client, `token_endpoint_auth_method: none` (`oidc-provider.factory.ts:61-66`).

### 3.2 Removal list (the actual work)

| Remove | Files | Replacement |
|---|---|---|
| Password/OTP auth UI | `src/sections/pages/auth/AuthSection.tsx` (steps `initial/signup/login/verify`), `useAuthMutation.ts`, `authApi.ts` login/register/OTP/reset | `AuthPage` becomes OAuth-only: provider buttons (Google, Microsoft, GitHub, Apple — from `GET /login/providers`) + `beginLogin(provider?)`; no form fields except email-as-hint where the OP interaction needs it |
| Legacy token store | `src/store/authStore.ts` (`localStorage` access tokens), `AuthContext.tsx` hydrate | Engine session store only (`src/lib/engine/auth.ts`); delete `authStore` once no importer remains |
| Legacy API client | `src/api/*` axios instance, Bearer injector, 401 queue (`index.ts:44-93`) | `engine()` for everything authenticated; keep plain `fetch` for the 3 public forms (contact/newsletter/careers → their real endpoints, §7) and delete the `ERR_DEV_BLOCKED` interceptor |
| Test bypasses | `auth.ts:53-66` dummy token, `SessionGate.tsx:13-15` passthrough, `session-gate.ts:19-22` early return | Real gates; dummy code deleted, not flagged |
| `/auth` marketing route | `routes.tsx:232-236` + `AuthPage` password UI | Redirect `/auth` → `beginLogin()` (preserves bookmarks); keep route path as thin redirector for one release, then remove |

### 3.3 Session edge cases (must all be handled, none optional)

- Return-target validation (in-app paths only — `AuthCallbackPage.tsx` already does this; keep).
- Refresh race: single-flight refresh already in `client.ts:169-181`; add tab-coordination via `storage` event on `neryva.refresh_token` (last-writer-wins + broadcast `neryva.session_cleared` for logout-everywhere).
- Org switch: `setActiveOrg` → `localStorage neryva.active_org` → invalidate all org-scoped queries (query-key prefix `['org', orgId]`).
- 401-fatal: `onFatalAuth` → clear + `beginLogin()` preserving current path.
- Session revocation elsewhere (`POST /auth/me/sessions/:sid/revoke`, `SettingsSecurity.tsx:458,477` already wired): on next 401, same fatal path.
- MFA: Engine may demand step-up per action, not per session (`step_up_required` → `runWithStepUp`, `stepup.ts:68-78`; `SettingsSecurity.tsx` TOTP UI already exists and stays).

### 3.4 Exit gates — Phase 0

- [ ] No password/OTP/reset strings in `src/pages`, `src/sections/pages/auth`, or `src/api` (grep-proven).
- [ ] No `localStorage` access-token read/write (grep-proven; `neryva.active_org` + non-secret UI prefs excepted).
- [ ] `SessionGate` + `requireEngineSession()` enforced on `/agent-studio`, `/deployment`, `/platform/*` (except `/platform/auth/callback`).
- [ ] Login → social → callback → return-target round-trip passes manually against Engine OP; logout ends Engine session (grant revoked, `oidc-adapter.ts:135-160`).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.

---

## 4. Feature build map — Agent Studio (one row = one shippable slice)

Conventions for every row: React Query keys `['org', orgId, <domain>, …]`; cursor loops on `next_cursor` (never page numbers, except members `limit/offset` which is Engine's only offset list); `Idempotency-Key: <uuidv7>` on every mutation; `describeEngineError` + `toastEngineError` for failures; `canPerform(role, state)` gates (UI) with Engine guards authoritative; step-up modal for the StepUp set (§1.3 tail).

### 4.1 Shell, home, onboarding, status (first — frames everything)

| View | Engine source | Work |
|---|---|---|
| `AgentStudioShell` + dashboard | `GET /console/home`, `GET /console/org/:orgId/limits`, `GET /console/onboarding`, `GET /console/status` | Static shell nav → TS constant (cut `@neryva_data` import); dashboard cards from `home` + `limits`; first-run checklist from `onboarding` (computed live server-side — no local flags); status center from `status` + announcements; entitlement banner via `resolveCta` (trial/billing/past-due states) |
| Notifications | `GET /console/notifications`, `POST …/:id/read`, `POST …/read-all` (+ `GET /auth/me/notifications` user scope) | `NotificationsPopover` already exists — re-point to console endpoints, badge from `unread` filter |

### 4.2 Agents — lifecycle core (largest slice)

| Action | Engine endpoint | Notes |
|---|---|---|
| List / detail | `GET …/assistants`, `GET …/assistants/:id` | Already live (`useAssistants.ts`); add server-driven empty states; `AgentsView.tsx:69-116` hardcoded 6 entries must be deleted (they shadow the API) |
| Create | `POST …/assistants` (`{template}` xor `{definition}`) | `AgentsView.tsx:367` create + `AgentEditor.tsx:86` draft-save exist; enforce contract caps client-side **before** send (instructions ≤ 20,000 — the tighter of Engine 32,768 / contract 20,000; models ≤ 16; tools ≤ 32) |
| Versions list / create draft | `GET/POST …/:id/versions` | Fix `useSaveDraftVersion` (`useAgentAuthoring.ts:387-400`): post the four policies **top-level** per `CreateVersionDto` (`dto.ts:80-99`) — the current nested `{definition}` payload fails validation, so no full definition lands today. Draft edits go through `PUT …/:id/versions/:v/draft` with required `If-Match: <hash>` (stale → 412 `precondition_failed` + expected/current hashes, merge-or-reload; same-hash retry succeeds) and `DELETE …/draft` discards DRAFT-only (`engine/src/modules/assistants/assistants.controller.ts:135-171`, `engine/src/modules/assistants/assistants.service.ts:375-438`, `draftWriteMissError:1393-1406`) |
| Publish / rollback / retire | `POST …/versions/:v/publish`, `POST …/rollback`, `POST …/versions/:v/retire` | Live (`AgentDetailView.tsx:476,388,518`); add BLOCK-gate surfacing (publish 422 with decision reason → link eval run), retired-version read-only treatment. Unresolved knowledge pins REFUSE publish/rollback with 422 + slugs (`engine/src/modules/assistants/assistants.service.ts:1208-1216`) unless `acknowledge_degraded_knowledge: true` in the body (audited as `assistant.publish_degraded_acknowledged`; `engine/src/modules/assistants/assistants.controller.ts:173-187,235-247`) |
| Export / import / snapshot / provenance | `GET …/export`, `POST …/versions/import`, `GET …/snapshot`, `GET …/provenance` | `AgentDetailView.tsx:359` import-draft exists; add file download (export), file-pick validated import (deterministic, `schema_version` shown), provenance timeline view |
| Test-run / evaluate | `POST …/versions/:v/test-runs`, `POST …/versions/:v/evaluate` → `eval_run_id` | New buttons on version row; test-run opens chat pinned to version; evaluate links to §4.7 run detail |
| Disable / enable / delete | `POST …/disable`, `POST …/enable`, `DELETE …` | `AgentDetailView.tsx:306` delete exists; owner/admin only; deleted → tombstone-aware 404 copy |
| Rollout + releases | `GET/POST …/rollout`, `POST …/rollout/pause`, `GET/PUT …/releases` | Rollout editor (pause/resume) + release-pointer table (`environment` × `channel`); channel-addressable releases validated against `assertAssistantRoutable` errors. Paused rows banner `paused_reason/by/at` verbatim (manual = actor, burn-rate = reason+costs; NULL = operator-paused-legacy — `engine/src/modules/assistants/schema.ts:175-177`). Burn-rate is service-only (hourly `billing.burn_sweep`, `engine/src/modules/billing/billing.worker.ts:61-119`; manual-resume cooldown suppression `BurnRateService.isSuppressedByManualResume`, `engine/src/modules/assistants/burn-rate.service.ts:89-144`, `BURN_RATE_RESUME_COOLDOWN_SECONDS` `engine/src/common/config/env.ts:97`) — operate UI surfaces state + audit, never a burn endpoint. Degraded banner reads `GET …/:assistantId/knowledge-health` (per-pin slug/resolved/state + degraded over ACTIVE pins — `engine/src/modules/assistants/assistants.controller.ts:122-127`, `engine/src/modules/assistants/assistants.service.ts:477-510`) |
| Control blocks | `GET/POST/DELETE …/control-blocks` | Kill-switch table (five levels); BLOCK creates here surface on publish; owner/admin only |

Authoring-field mappings (consumer obligation, from the setup detail plan — implement once in `useAgentAuthoring.ts`, not per view): approval `never→optional/none`, `on_effect|always→required` + catalog `REQUIRED`; `memory_scope` `org→organization` (Engine `user` has no consumer value — omit); `max_context_tokens`/`retrieval_policy`/`brand` are contract/consumer-side — never sent as Engine version fields; tool entries carry `{name, access, approval, schema_hash?}` only (effect class lives on the catalog row).

### 4.3 Templates (closes the flagship gap)

`TemplatesView.tsx:157` is toast-only — behind it there is no registry call at all. Wire: `GET …/assistant-templates` (badges `installed`/`update_available`) → detail (`GET …/:slug?version=`) with BOM tabs (definition / tool bindings incl. `effect_class` + `approval_requirement` + `when_to_use` / knowledge / channels+caps / eval rubric + release policy) → **Use template** = `POST …/assistants {template: {slug, version}}` (+ optional name) → navigate to the created assistant; `checkUpdates` comparison drives the update banner. Enforce `min_engine_schema` compatibility client-side (disable + reason when unmet). No template editing in console (BOMs are versioned in `products/agent-studio/templates/`, linted by `neryva-template lint`).

### 4.4 Tools, models, provider credentials

- Tools: `GET/PUT …/tools`, `GET …/tools/templates`, `POST …/tools/from-template`, `GET …/tools/:name`, `PATCH …/tools/:name/enabled`. Editor validates name `^[a-z][a-z0-9_]{1,63}$`, `input_schema` ≤ 16 KiB; credential shown **never** (sealed `enc:v1:` server-side; `ModelsView.tsx:87` auto-routing toggle is display-only until an Engine field backs it — either wire or remove).
- Models: `GET …/models` with per-model compatibility reasons (rendered as disable-reasons in the authoring model picker).
- Provider credentials: `GET …/provider-credentials` (fingerprints only — assert no secret material in responses during QA), `POST` (BYOK, owner/admin + step-up), `POST …/rotate`, `POST …/revoke`, provider enablements get/set. Staff provider-plane (`/internal/staff/...`) is never linked in the console.

### 4.5 Knowledge, memory, connectors, eval

- Uploads: `POST …/uploads` (purpose + media-type allowlist + byte bound + declared sha256) → presigned POST → direct-to-object PUT → `POST …/uploads/:id/complete` → stage polling (`GET …/uploads/:id`: `CREATED→UPLOADING→UPLOADED→SCANNING→EXTRACTING→INDEXING→READY` / `QUARANTINED`/`FAILED` with reason copy). `useAttachmentUpload.ts` exists — extend to this flow (exact content-length, checksum binding, multipart above threshold, abort-stale).
- Documents: `GET …/documents/search?query&limit` (limit clamp documented; READY-only is server-enforced — UI states it). Operate-view degraded banner reads `GET …/assistants/:assistantId/knowledge-health` (ACTIVE-version pins + degraded flag — `engine/src/modules/assistants/assistants.controller.ts:122-127`).
- Memories: `GET …/memories?scope_type&scope_id`, `POST …/memory-proposals/:id/decision` (approve/reject), `DELETE …/memories/:id` (soft-delete copy). Proposals queue is an explicit view (nothing auto-accepts).
- Connectors: `GET/POST …/connectors`, `POST …/:accountId/{state,sync}`.
- Eval (replace `EvaluationsView.tsx:70` toast): datasets/cases/runs/results/promote/reject/recall endpoints (`harness-parity.controller.ts:27-180`); run detail shows rubric bar (≥9/10, 0 critical fails), per-case PASS/FAIL with `must_not`/`tools_expected`, quality gates (WARN-only), `decision` PASS|WARN|BLOCK with provenance link back to the version (`assistant evaluate` returns `eval_run_id`).

### 4.6 Conversations, runs, streaming, approvals, escalations

- Conversations: `GET …/conversations?limit&assistant_id=`, detail, `POST …/status` (expected_version conflict copy), `POST …/messages` (DB-tier `idempotency_key` in body — `useChat.ts:320-367` flow stands), `regenerate`/`edit` (same), message `pin`, `feedback`, `title` PATCH, `shares` create/list/revoke (token shown once + copy), `export` (markdown slice note), all with cursor pagination (`after` → `next_cursor`).
- Chat view (`AgentStudioChatView` + `useChatSession`): keep the accepted→`runId`→SSE pattern (`useChat.ts:290-367`); harden the 15s accepted-fallback copy; coalesced assistant text + tool notices + usage notices + terminal finalize + query invalidation on terminal.
- Runs: `GET …/runs/:runId`, `GET …/events?after_sequence&limit` (history), `SSE …/events/stream` with `Last-Event-ID` resume (`useEventStream`), `POST …/cancel`, `POST …/result` (CommitRunResult — developer+ only, confirm modal), `POST …/capability` (never displayed — mint-and-use internally; if shown anywhere, remove).
- Approvals: `GET …/approvals?state=`, `POST …/approvals/:id/extend`, decision via `POST …/runs/:runId/approvals/:approvalId/decision` (APPROVED/DENIED + one-time decision idempotency). Waiting runs surface in chat + a dedicated queue view.
- Escalations: full claim/assign/resolve/reply flow (`escalations.controller.ts:22-128`); human-handoff entry from chat.

### 4.7 Usage, billing, audit, lifecycle, webhooks, teams, settings

Mostly built in `/platform` + Studio settings tabs — complete, don't rebuild: usage overview/series/rollup + ledgers/invoices/credits/budgets/adjustments/usage-export (`UsageBillingPages.tsx`, `UsageView.tsx`, `AnalyticsView.tsx`); audit list/facets/NDJSON-export/chain-verify (`AuditPage`, `ComplianceView.tsx:604`); lifecycle retention/purge/holds/exports/tombstones (`ComplianceView.tsx`, `useLifecycle.ts`, `useConfigLifecycle.ts`); webhooks catalog→test→deliveries→rotate (`useWebhooks.ts`, `WebhooksView.tsx` — note Engine has **no** `@Idempotent` on webhook update/rotate/test, so the UI must still send keys + disable-while-pending); notifications (`useNotifications.ts`); members/invites/groups/service-accounts/projects/keys (`TeamsView.tsx`, settings tabs, `ApiKeysPage.tsx` — key secret shown once + copy, rotate/revoke with step-up); sessions/MFA/account-deletion (`SettingsSecurity.tsx`, `SettingsProfile.tsx` already comprehensive).

Channels (`channels.controller.ts`, `templates.controller.ts`, widget plane) ship in the last Studio milestone only if the release needs them — template `channels` bindings display as read-only until then.

---

## 5. Known-gap closure register (each = acceptance criterion)

| # | Gap (observed) | Fix | Engine proof |
|---|---|---|---|
| G-1 | `TemplatesView.tsx:157` install is `toast.success` only | §4.3 wiring; button disabled until `GET …/:slug` loads; success navigates to created assistant | `POST …/assistants {template}` `assistants.controller.ts:19-29` |
| G-2 | `AgentsView.tsx:69-116` hardcoded 6 agents | Delete hardcoded entries; list API is source; create stays `POST …/assistants` | `GET …/assistants` `:32` |
| G-3 | `useSaveDraftVersion` posts nested `{definition}`, Engine requires top-level policies → validation failure | Flatten to `CreateVersionDto` shape; pre-validate with contract caps | `dto.ts:80-99`, `validation.ts:42-84` |
| G-4 | Approval vocabulary mismatch (`never/on_effect/always` vs Engine `required/optional` vs contract `required/none`) | Central mapping in `useAgentAuthoring.ts` per §4.2 | `validation.ts:65`, `v1.schema.json:140-145` |
| G-5 | `memory_scope org` vs Engine `organization`; Engine `user` has no consumer value | Mapping + omit; contract default `user` | `v1.schema.json:104-109` |
| G-6 | `EvaluationsView.tsx:70` queue is toast-only | §4.5 eval wiring; run detail with rubric + decision | `harness-parity.controller.ts:75-114` |
| G-7 | `ModelsView.tsx:87` auto-routing toggle unwired | Wire to a real Engine field or delete the toggle | `model-catalog.controller.ts:18` |
| G-8 | Studio views import `@neryva_data/products/agent_studio/*` as runtime data | Static TS constants; JSON stays marketing-only | `AgentStudioShell.tsx:73-77` |
| G-9 | `session-gate`/`SessionGate`/dummy-token bypasses | Deleted in Phase 0 (§3.2) | `session-gate.ts:19-22`, `SessionGate.tsx:13-15`, `auth.ts:53-66` |
| G-10 | Deployment shell fully toast-driven (`DeploymentsView`, `PipelinesView`, secrets, teams, settings) | Hidden per §9, not fixed here | `src/sections/pages/products/deployment/*` |

---

## 6. Cross-cutting frontend standards (no exceptions)

- **Transport:** `engine<T>()` only. Same-origin `/engine` proxy in dev and edge in prod (`client.ts:16-24`); `VITE_ENGINE_URL` for exotic topologies only. `credentials: 'include'` always; `X-Neryva-Org` from `OrgProvider`; `Idempotency-Key` (uuidv7) on every mutation; `X-MFA-Proof` via step-up runner; `{error:{code,…}}` → `ApiError` → `describeEngineError` → tone/title/action/ret retryable flag (`errors.ts`).
- **State:** React Query owns server state (`staleTime 5min` baseline from `main.tsx:15-32` stands; shorten to ~15s for run/approval queues, `no-cache` for audit-verify); zustand owns session/org/UI prefs only. No fetched data in zustand. Query keys always start `['org', orgId, …]` so org-switch invalidation is one prefix.
- **Streaming:** `useEventStream` everywhere; reconnect backoff+jitter + `Last-Event-ID` already implemented (`sse.ts:190-235`); on terminal event: finalize transcript, invalidate `chat-messages`/`chat-runs`, stop reconnecting after grace. Slow-consumer behavior: drop to history-refetch (`GET …/events?after_sequence=`) rather than buffering unboundedly.
- **Forms:** controlled inputs, schema validation mirroring Engine bounds (contract caps §4.2 + tool name regex + `input_schema` 16 KiB note), server 422 renders field errors (never generic toast), dirty-guard on navigate-away for the agent editor.
- **Files:** object keys never use user filenames (server binds them); client sends exact byte length + sha256 it computed; MIME allowlist message comes from server errors, not a client list.
- **Security:** no secret material rendered (provider credentials = fingerprints; API keys/shares/proof secrets shown once with copy + never re-fetchable); `rel=noopener` on `docs_url`/external; no `dangerouslySetInnerHTML` for server content (markdown export renders via sanitizer); CSP `form-action 'self'` preserved for login-adjacent pages.
- **A11y/i18n:** keyboard-reachable dialogs/menus, focus-trap in modals (step-up, publish-confirm, destructive confirms), `aria-live` for stream-appended chat text and toast region, visible focus, contrast-checked status colors (terminal/failed/quarantined states never color-only). Copy is English-only this release; no i18n framework until a second locale is committed.
- **Telemetry:** Web-vitals + route-level error counts + SSE reconnect counts to the existing observability pipeline; no PII in analytics events (org/actor ids hashed or omitted per Engine telemetry policy).

---

## 7. Static pages (kept, bounded)

Marketing/static behavior is frozen except: (a) delete `ERR_DEV_BLOCKED` and point contact/newsletter/careers/blog at their real endpoints (or JSON-only where no endpoint exists — blog already degrades to `posts.json`); (b) `/auth` becomes the OAuth redirector (§3.2); (c) no new marketing routes in this plan. `brand:images`/`encrypt:content` scripts untouched.

---

## 8. Quality gates (every milestone)

- [ ] `pnpm typecheck && pnpm lint && pnpm test` green (existing vitest suites incl. `useStudioConversations/useOnboarding/useNotifications/useStudioStatus` + `NotificationsPopover` stay green; new hooks/views ship with tests).
- [ ] No axios `src/api` imports outside the 3 public forms (grep gate); no `localStorage` tokens (grep gate); no `@neryva_data/products/*` imports in app shells (grep gate).
- [ ] Contract check: all consumed paths exist in the composed Engine OpenAPI (`scripts/export-openapi.ts` artifact); added query params match server clamps (documents `limit` 1–20, conversations `limit` ≤ 100, usage-export 10k note).
- [ ] Manual QA scripts pass per milestone: OAuth round-trip, org switch, agent create→version→publish→chat→approve→terminal, template install, upload→READY, proposal decision, invoice draft→issue, audit export+verify, lifecycle export download (one-time token), webhook test delivery, SSE disconnect/reconnect with identical replay.
- [ ] Red-team pass on the console: cross-org URL tampering (`:orgId` swap → 403), direct-link to admin actions as reader (hidden + denied), replayed `Idempotency-Key` with different body (409), stale `expected_version` write (conflict, no data loss), share-token URL (uniform 404 when invalid).

---

## 9. Deployment shell — dormant, not deleted

Per directive the deployment console waits: hide `/deployment` nav entries and deep-link cards behind a build flag (default off), keep routes mounted (no 404 regressions for bookmarked URLs — render a `_coming soon_` state), and do zero wiring work. Engine's deployment plane (`product_deployment.*`, 38 console routes) is acknowledged but out of scope until declared ready; the flag flips in a later plan. No deployment acceptance criteria in this plan.

---

## 10. Milestones (build order — each shippable, each gated by §8)

```text
M0 Auth + transport hardening (§3)
  → M1 Shell/home/onboarding/status/notifications (§4.1) + static-pages freeze (§7)
  → M2 Agents lifecycle + authoring fixes (G-2,G-3,G-4,G-5, §4.2)
  → M3 Templates install (G-1, §4.3) + Tools/Models/Credentials (§4.4)
  → M4 Knowledge/memory/connectors + Eval queue/detail (G-6, §4.5)
  → M5 Conversations/chat/SSE/runs/approvals/escalations (§4.6)
  → M6 Money/compliance/governance completion (§4.7) + G-7/G-8 cleanup
  → (later plan) Deployment shell + website widget track
```

Do not begin with the widget, deployment wiring, or a second design system. The console's highest-risk work is auth/session correctness, authoring-payload validity, idempotent mutations, cursor/SSE correctness, and entitlement-gated rendering; those prove first.

---

## References

- `console/neryva-website/src/router/routes.tsx` — route tree (marketing §92–156, platform §166–224, studio §238–416, deployment §418–576, callback §594–597)
- `console/neryva-website/src/lib/engine/{client,auth,sse,session-gate,errors,capabilities,stepup}.ts` — transport/session/policy layer
- `console/neryva-website/src/hooks/studio/*` (21 files) + `src/sections/pages/products/agent-studio/*` — existing views/hooks to extend
- `engine/src/modules/{assistants,conversations,knowledge,channels,billing,lifecycle,webhooks,organizations,console,identity}/*controller.ts` — endpoint authority (see §1.3/§4 citations)
- `products/agent-studio/contracts/agent-definition/v1.schema.json` — authoring caps consumed in §4.2
- `products/agent-studio/templates/registry.json` + `scripts/generate-template-registry.mjs` — template BOM shape consumed in §4.3
- `engine/docs/dev/agent_related/_agent_setup_detail_plan.md` — system gaps G-1…G-5 evidence (TemplatesView/AgentsView/useSaveDraftVersion/mappings)
