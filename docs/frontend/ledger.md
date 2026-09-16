# Neryva Frontend Implementation Ledger — Console & Product UI

## Document status

| Field | Value |
|---|---|
| Source of truth | `frontend_implementation_plan.md` (277 lines), `agent-setup.md` (117 lines), `first-run-onboarding.md` (169 lines), `team-loop.md` (172 lines), `README.md` (60 lines) — all `spec DONE 2026-09-15` |
| Companion boundaries | `docs/architecture/engine/imp/ledger.md` (Engine control plane), `docs/architecture/engine/*`, `docs/architecture/neryva_mcp/*`, `products/agent-studio/` (Temporal+TS runtime, headless), `products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`) |
| Scope | `console/neryva-website` (Vite + React 18 + TanStack Router + TanStack Query + zustand) — three shells: marketing static, `/platform` org admin, `/agent-studio` product console (`/deployment` dormant). Wired to Engine REST/JSON + SSE only — never MCP, never Studio runtime-control, never Temporal |
| Out of scope | Engine tenancy/RLS, billing math, MCP wire, Studio execution internals, `products/neryva_agent_studio` (quarantined Python prototype — salvage IA only), website widget plane (`public/channels`, `nk_live_` — separate track) |
| Ledger type | Phase-gated execution tracker — one checkbox = one verifiable deliverable with evidence. Mirrors `engine/imp/ledger.md` vocabulary: `TODO → CODE_COMPLETE → GATES_PENDING → DONE` |
| Rule | No phase may be marked `DONE` without its exit-gate evidence (typecheck + lint + vitest + composed OpenAPI contract check + manual QA script). One ledger ID per PR, reference in title/description. Docs describe, code decides — if doc/code disagree, code wins and doc is amended same session |
| Date / snapshot | 2026-09-15 — codebase at `neryva-website@0.0.0`, Engine `fa947e3` (residual safety round: draft OCC, pin-refuse gate, burn cooldown, knowledge-health), 21 studio hooks in `src/hooks/studio/*`, Engine surface inventoried 2026-09-15 per §1.3 of plan |

> This ledger **replaces** the deleted `backend_gaps.md` (frontend-derived register B-1..R-4 folded below as FE-B1..FE-R4). Placement after this file: binding Engine gaps stay `docs/dev/agent_related/release_readiness/release_gap_report.md` (GAP-xx/REL-xx); this ledger tracks the console build and the Engine prerequisites it depends on.

---

## 1. How to use this ledger

1. Work strictly in milestone order M0→M6. Each task cites spec section and current file(s) to change.
2. A task is `DONE` only when **code + test + evidence** land together:
   - `code`: file path + line range (paths repo-root-relative `neryva_studio/`: `console/neryva-website/src/...`, `engine/src/...`, `products/...`)
   - `test`: vitest/unit, grep-gate, contract check, or manual QA script
   - `evidence`: `pnpm typecheck && pnpm lint && pnpm test` green + `scripts/export-openapi.ts` composed OpenAPI exists + QA script log
3. Every mutation sends `Idempotency-Key: <uuidv7>` and renders `describeEngineError` verbatim — checked per task, not assumed.
4. Role×entitlement gating (`canPerform` in `src/lib/engine/capabilities.ts`) hides/disables UI, but Engine `OrgRolesGuard`/`EntitlementGuard`/`StepUpGuard` is authoritative — never treat a hidden button as a security boundary (`frontend_implementation_plan.md:20`, `agent-setup.md:86`, `team-loop.md:126`).
5. Treat `frontend_implementation_plan.md:15-20` (5 invariants) + `README.md:28-34` (locked decisions) as invariant gates from M0 onward.

---

## 2. Ground truth — what exists today (factual 2026-09-15)

### 2.1 Console shape to preserve

| Part | Location | State |
|---|---|---|
| Static SaaS pages | `src/pages/{home,research,resources,company,contact,products,solutions,secret,auth}` + `src/neryva_data/**` (`@neryva_data`, `vite.config.ts:27`) + `src/lib/data/*` | Correct — JSON-fed marketing, keep. Only forms touch Engine |
| Platform shell (org admin) | `src/pages/platform/*` + `src/lib/engine/*` client (`client.ts`, `auth.ts`, `sse.ts`, `session-gate.ts`, `errors.ts`, `capabilities.ts`, `stepup.ts`) | Partially wired — home/limits/onboarding/status/notifications + members/projects/keys/usage/billing/audit/settings — keep and complete |
| Agent Studio shell | `src/pages/products/agent_studio/*` + `src/sections/pages/products/agent-studio/*` + `src/hooks/studio/*` (21 files) | Mixed — shell, chat SSE, agents CRUD/publish/rollback/retire, teams, compliance, settings tabs already call Engine; gaps in §5 G-1..G-10 (notably `TemplatesView.tsx:157` toast-only install, `EvaluationsView.tsx:70` toast-only queue, `AgentsView.tsx:69-116` hard-coded 6 entries, `useAgentAuthoring.ts:387-400` nested `{definition}` mis-wired, `ModelsView.tsx:87` unwired toggle, `@neryva_data/products/agent_studio/*` import in `AgentStudioShell.tsx:73-77`) |
| Deployment shell | `src/pages/products/deployment/*` | Mock-only toast — dormant per directive, hide behind flag (§9) |

### 2.2 Auth is dual-stack (M0 fixes to OAuth-only)

- Legacy marketing backend `src/api/*` (axios, `API_BASE_URL` `/api/v1` / `https://neryva-backend.vercel.app/api/v1`, `src/api/index.ts:4-12`) with email/password/OTP/reset (`authApi.ts:14-106`), Bearer from `useAuthStore` (`src/api/index.ts:44-50`, `src/store/authStore.ts:36-70` `localStorage`).
- Engine OP session `src/lib/engine/{client,auth,sse,session-gate,errors,capabilities,stepup}.ts` — PKCE `S256` only (`oidc-provider.factory.ts:68-71`), `neryva-console` public client `token_endpoint_auth_method: none` (`identity.module.ts:98-132`), social handshake `social-login.service.ts:17-78`, JWKS overlap `jwks-custody.ts:6-60`, fail-closed prod checks `env.ts:354-402`. Pieces exist but **bypassed**: `auth.ts:53-66` dummy token, `SessionGate.tsx:13-15` passthrough, `session-gate.ts:19-22` early return.

### 2.3 Engine surface the console consumes (no new Engine endpoints proposed except FE-B1..FE-R4 prerequisites below)

Org context `X-Neryva-Org` fallback only for `GET /console/home`, `GET /console/onboarding` (`org-roles.guard.ts:38-44`), L2 key-derived org (`conversations.public.controller.ts:28-30`). Full inventory in plan §1.3/§4 — cited per task below. Writes are `@Idempotent()` except assistant DELETE/retire, keys revoke, webhook update/rotate/test, invoice issue/pay/void, budget delete, message-accept (`dto.idempotency_key` in body) — UI must send keys regardless (server treats unknown keys as new).

---

## 3. Phase overview (6 milestones — same critical path as `frontend_implementation_plan.md:252-265`)

| Phase | Name | Goal | Depends on | Current % | New files / major edits |
|---|---|---|---|---|---|
| **M0** | Auth + transport hardening | OAuth-only, no password/OTP, no token in `localStorage`, transport/session correctness | — | 0% | `src/pages/auth/*`, `src/api/*`, `src/store/authStore.ts`, `src/lib/engine/*`, `src/components/platform/SessionGate.tsx`, `routes.tsx`, `AuthCallbackPage.tsx` |
| **M1** | Shell / home / onboarding / status + static freeze | Frame every later view; first 60s flawless | M0 | 0% | `src/pages/platform/*`, `src/lib/engine/*`, `src/sections/pages/products/agent-studio/AgentStudioShell.tsx`, onboarding/checklist/status/notifications views |
| **M2** | Agents lifecycle core | Immutable versions, publish correctness, operate emergency levers | M1 | 0% | `src/sections/pages/products/agent-studio/agents/*`, `src/hooks/studio/useAgentAuthoring.ts`, `src/hooks/studio/useAssistants.ts` |
| **M3** | Templates + Tools/Models/Credentials | Flagship template gap closed; provider trust verified visually | M2 | 0% | `TemplatesView.tsx`, `ModelsView.tsx`, tool/provider views |
| **M4** | Knowledge / memory / connectors / eval | Upload pipeline + permission-sync truth + eval loop off toast | M3 | 0% | `src/hooks/studio/useAttachmentUpload.ts`, knowledge/memory/connector/eval views |
| **M5** | Conversations / chat / SSE / runs / approvals / escalations | Durable chat correctness + streaming reconnection + human-in-loop queues | M4 | 0% | `AgentStudioChatView`, `useChat.ts`, `useChatSession`, `useEventStream`, approvals/escalations views |
| **M6** | Money / compliance / governance completion + cleanup | Usage/billing/audit/lifecycle/webhooks/teams/settings + G-7/G-8 + dormant deployment | M5 | 0% | `src/pages/platform/{usage,billing,audit,compliance}*`, `src/sections/pages/products/agent-studio/settings/*`, `src/hooks/studio/useWebhooks.ts` |
| **INV** | Invariants + quality gates | Hold M0→M6 | All | — | Grep gates, OpenAPI compose, manual QA scripts |

> `*%` is execution, not spec. All specs are `DONE`; code is `TODO` until M0→M6 gates green. `fa947e3` already landed the Engine prerequisites for draft OCC, pin-refuse, burn cooldown, knowledge-health — M2 consumes them.

---

## 4. Phased ledger — atomic tasks

> Each task: `checkbox` + **bold ID** + spec citation + scope → `files` → exit signal. Check only when signal is in `main`.

### Phase M0 — Auth + transport hardening (`frontend_implementation_plan.md:85-136`, `README.md:28`)

*Objective: OAuth-only is the only path; no password/OTP strings remain; no `localStorage` token; transport/session correctness proven before any product view.*

- [ ] **M0.1** Delete legacy password/OTP auth UI — remove steps `initial/signup/login/verify` and OTP/reset forms — `frontend_implementation_plan.md:112-114` → `src/sections/pages/auth/AuthSection.tsx`, `src/hooks/useAuthMutation.ts`, `src/api/authApi.ts:14-106` → grep `password.*otp|verify.*code|reset.*password` finds zero hits in `src/pages`, `src/sections/pages/auth`, `src/api`.
- [ ] **M0.2** Delete legacy token store — `src/store/authStore.ts:36-70` `localStorage` access tokens + `AuthContext.tsx` hydrate — `frontend_implementation_plan.md:115` → delete `authStore.ts` once no importer remains → `grep -R localStorage.*token` finds only `neryva.active_org` + `neryva.pending_invite` + non-secret UI prefs.
- [ ] **M0.3** Delete legacy API client — axios instance, Bearer injector, 401 queue — `src/api/index.ts:44-93` → `frontend_implementation_plan.md:116` → `engine()` (`src/lib/engine/client.ts:16-24`) is sole authenticated transport; keep plain `fetch` for 3 public forms (contact/newsletter/careers → real endpoints, `frontend_implementation_plan.md:232`) and delete `ERR_DEV_BLOCKED` interceptor `src/api/index.ts:31-42` → `grep -R "from 'src/api'"` zero outside those 3 forms.
- [ ] **M0.4** Delete test bypasses — `auth.ts:53-66` dummy `dev-dummy-access-token`, `SessionGate.tsx:13-15` passthrough, `session-gate.ts:19-22` early return — `frontend_implementation_plan.md:117` → real gates only, dummy code deleted not flagged → `grep dummy` zero.
- [ ] **M0.5** `/auth` becomes OAuth redirector — `routes.tsx:232-236` + `AuthPage` password UI → `frontend_implementation_plan.md:118` → `routes.tsx` redirects `/auth` → `beginLogin()` (preserves bookmarks), keep path as thin redirector one release → manual: `/auth` navigates to Engine `/auth?client_id=neryva-console` with return target stashed in `sessionStorage`.
- [ ] **M0.6** Enforce session gates — `SessionGate` + `requireEngineSession()` on `/agent-studio`, `/deployment`, `/platform/*` except `/platform/auth/callback` — `frontend_implementation_plan.md:133` → `src/components/platform/SessionGate.tsx`, `src/lib/engine/session-gate.ts` → unauthenticated hit on any of those paths redirects to login, callback remains public.
- [ ] **M0.7** Implement target OAuth flow — `frontend_implementation_plan.md:89-109` → `src/lib/engine/auth.ts:1-17,44-52,89-100,206-215`, `src/lib/engine/client.ts:16-24,150-181`, `vite.config.ts:41-45` (same-origin `/engine` proxy, `credentials:'include'`, `VITE_ENGINE_URL` exotic only) → `beginLogin()` stashes return path + PKCE verifier/state (`sessionStorage`) → `location.assign(ENGINE /auth?client_id=neryva-console&scope=openid email profile offline_access)` → social `GET /login/:uid/social/:provider` → `handleAuthCallback()` validates `code/state/verifier` → token grant → `applyTokens` (access memory-only, refresh `sessionStorage`) → navigate to stashed in-app target else `/platform`.
- [ ] **M0.8** Harden session edge cases — `frontend_implementation_plan.md:122-127` → `src/lib/engine/auth.ts`, `src/lib/engine/client.ts:169-181` (single-flight 401 refresh) + `storage` event tab-coordination on `neryva.refresh_token` (last-writer-wins + broadcast `neryva.session_cleared` for logout-everywhere) → `AuthCallbackPage.tsx` return-target allowlist (in-app only) → `setActiveOrg` → `localStorage neryva.active_org` → invalidate all `['org', orgId, …]` queries → `onFatalAuth` → clear + `beginLogin()` preserving path → `POST /auth/me/sessions/:sid/revoke` (`SettingsSecurity.tsx:458,477`) fatal 401 path covered → `runWithStepUp` `stepup.ts:68-78` (step-up per action, not per session).

#### Exit gates — M0

- [ ] No `password`/`OTP`/`reset` strings in `src/pages`, `src/sections/pages/auth`, or `src/api` (grep-proven).
- [ ] No `localStorage` access-token read/write (grep-proven; `neryva.active_org` + `neryva.pending_invite` + UI prefs excepted).
- [ ] `SessionGate` + `requireEngineSession()` enforced on `/agent-studio`, `/deployment`, `/platform/*` except callback.
- [ ] Login → social (Google/Microsoft/GitHub/Apple via `GET /login/providers`) → callback → return-target round-trip passes manually against Engine OP; logout ends Engine session (grant revoked `oidc-adapter.ts:135-160`).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.

---

### Phase M1 — Shell, home, onboarding, status + static freeze (`frontend_implementation_plan.md:143-149,230-243`, `first-run-onboarding.md`, `team-loop.md`, `README.md:28-39`)

*Objective: shell nav is TS-constant, dashboard/checklist/status are live server truth, first 60s never lose an invite, static pages frozen.*

- [ ] **M1.1** Cut `@neryva_data` from app shells — `AgentStudioShell.tsx:73-77` imports `@neryva_data/products/agent_studio/*` as runtime data → `frontend_implementation_plan.md:80,212` → replace with static `src/lib/nav.ts` constant → `grep -R "@neryva_data/products"` zero in `src/pages/products` + `src/sections/pages/products`.
- [ ] **M1.2** Wire dashboard — `AgentStudioShell` + dashboard from `GET /console/home`, `GET /console/org/:orgId/limits`, `GET /console/onboarding`, `GET /console/status` → `frontend_implementation_plan.md:147` → cards from `home` + `limits` + live `onboarding` checklist (no local completion flags) + status center + entitlement banner `resolveCta` (trial/billing/past-due) → empty states server-driven; announce list via `GET /console/announcements`.
- [ ] **M1.3** Wire notifications — `GET /console/notifications`, `POST …/:id/read`, `POST …/read-all` (+ `GET /auth/me/notifications` user scope) → `frontend_implementation_plan.md:148` → re-point `NotificationsPopover` to console endpoints, badge from `unread` filter, correct per-kind `data.target` deep-link (`notifications.service.ts:60-204` — verify `org.invite_created` + member/role/billing kinds).
- [ ] **M1.4** Freeze static pages — `frontend_implementation_plan.md:232-233` → delete `ERR_DEV_BLOCKED`, point contact/newsletter/careers at real endpoints (blog degrades to `posts.json` where no endpoint), `/auth` redirector per M0.5, no new marketing routes, `brand:images`/`encrypt:content` untouched.
- [ ] **M1.5** First-run onboarding screen (Flow A: direct signup) — `first-run-onboarding.md:1,30-62` → `POST /platform/auth/callback?code&state` → `GET /console/org/contexts` → iff exactly 1 membership AND org fresh (`org_settings` row absent or `created_at` within session) → ONE screen: identity row (avatar/name/email `claims.name ?? local-part`, email read-only never verification), display name prefilled `claims.name ?? local-part` → `PATCH /auth/me {display_name 1..256}` (`account.controller.ts:99-107`) + workspace name prefilled `"<local>'s workspace"` → `PATCH /console/org/:orgId/settings {name 1..256}` (`org-settings.service.ts:101-130`, audited) via `Promise.allSettled` each with own `Idempotency-Key` (settings additionally `@Idempotent`) → `[Continue →]` skippable (partial failure → log + advance anyway, never error screen) → dashboard (`org context = personal org`) → live onboarding checklist `GET /console/onboarding` (`console-platform.controller.ts:75-80`). Max 2 fields, both prefilled, no company-size/role/use-case survey, no slug field, no trial pitch here.
- [ ] **M1.6** Invited-user path (Flow B) — `first-run-onboarding.md:65-112`, `team-loop.md:65-105` → `GET /platform/invites/:inviteId?token=` **frontend must own this route** (does not exist yet) → stash `{inviteId, token, savedAt}` in `localStorage neryva.pending_invite` (sole `localStorage` session exception per `README.md:28`, `first-run-onboarding.md:70-76` — newest wins, NOT `sessionStorage` due to mobile OAuth app-switch loss) → if anonymous: OAuth first (auto-creates account + personal org via `AccountCreated` unconditional `org-access.service.ts:37-82`) → ALSO stash invite URL as post-login return target (re-stash on every load, self-heals storage loss) → on callback with stashed invite (<30 min else ignore) → side-effect-free preview `POST console/org/invites/:inviteId/preview {token}` body-only (never query — proxies + Fastify `logger.ts:8` log `req.url` outside `REDACT_PATHS logger.ts:18-58`; body keys like `*.token` are redacted) → render org name/inviter/role/expiry + `email_hint j***@acme.com` (masked) → `[Accept]` → `POST …/invites/:inviteId/redeem` (`@Idempotent` + `org-invite-redeem` rate-limited `org.controller.ts:161-162`, hash-only lookup `invites.service.ts:218-286`) handling 403 `sent to a different email address` (`invites.service.ts:243-246`), 409 expired/revoked/locked/used (`:232-240,266-268`), 409 seat-full (`memberships.service.ts:277-279,314` — invite stays valid), 409 `member_suspended` (`invites.service.ts:61-99`) with verbatim copy + switch-account / `Continue to my workspace` exits (`first-run-onboarding.md:103-109`, `team-loop.md:103-105`) → `setActiveOrg = redeem.orgId` (never `contexts[0]`) via `neryva.active_org` (`OrgContext.tsx:44,84-85`) BEFORE routing → land directly in inviter's org with banner `"<Admin> invited you to <Workspace> as <role>"`, NO first-run screen, NO workspace-name step, role-scoped dashboard (`capabilities.ts` + server guard). Stash lifecycle: clear on success + TERMINAL failures, RETAIN on seat-full / email-mismatch retryable; `Referrer-Policy: no-referrer` on invite page.
- [ ] **M1.7** Handle onboarding edge cases — `first-run-onboarding.md:115-128` → OAuth email matches existing (`upsertByEmail` no duplicate), unverified IdP email anti-takeover (`social-account.service.ts:67-73` fresh subject-only), abandonment (dashboard defaults, rename later), invite on `personal` org (no kind gate — allowed), returning user 2+ orgs → picker (freshness server-derived), `ownership_cap_reached`/`slug_taken`/`slug_reserved` 409s (`org-access.service.ts:93-135`, `ORGS__MAX_OWNED_PER_ACCOUNT`), `personal org IS the company org` help copy.
- [ ] **M1.8** Invite share UX (manual delivery) — `team-loop.md:52-56` → success panel (manual only): masked link field reveal-while-open + **Copy** (clipboard + "copied" confirm) + **Compose email** `mailto:` prefilled (subject `You've been invited to {org} as {role}`, body inviter line + role one-liner per `team-loop.md:34-41` + link alone on line + expiry `valid {N} days` + mismatch warning `sign in with {email}`) + **Done** (masks permanently, unmounts, secret leaves memory, no telemetry). `accept_url` host is server-built from `ENGINE_BASE_URL` (`inviteUrl()`), never request `Host`.
- [ ] **M1.9** Activation instrumentation — `first-run-onboarding.md:59-62,152-158` → define once: first successful assistant run in org (production or `run_kind='test'` both write same projection) → instrument signup→activation within-session + within-7-days from day one.

#### Exit gates — M1

- [ ] OAuth → callback → (first-run screen iff fresh single org) → dashboard in ≤2 screens, both fields prefilled, both skippable.
- [ ] `PATCH /auth/me` + `PATCH settings` emit with `Idempotency-Key`; 422 renders as field errors; partial failure advances anyway.
- [ ] Invited users land in inviter org with context banner, never see workspace-name step; `neryva.pending_invite` stash survives new-tab / mobile app-switch and 30-min expiry respected; re-stash from URL self-heals.
- [ ] `GET /platform/invites/:inviteId?token=` route owns `token` in URL → stashes → preview `POST` body-only → uniform 404 for non-usable states, no token in logs/audit, `Referrer-Policy: no-referrer`.
- [ ] Checklist reflects `GET /console/onboarding` truthfully (no client flags).
- [ ] No `@neryva_data/products/*` imports in app shells (grep gate).
- [ ] Static pages: `ERR_DEV_BLOCKED` removed, 3 forms hit real endpoints, `/auth` redirects.

---

### Phase M2 — Agents lifecycle core (`frontend_implementation_plan.md:150-165`, `agent-setup.md:22-28,36-46,69-82,86-90`)

*Objective: largest slice — authoring payloads are valid top-level, drafts never clobber, publish correctness (pins, BLOCK, residency) is surfaced with fix paths, operate emergency levers are trustworthy. Consumes Engine `fa947e3` prerequisites.*

- [ ] **M2.1** List / detail — `GET …/assistants`, `GET …/assistants/:id` → `frontend_implementation_plan.md:154` → keep `useAssistants.ts` live, add server-driven empty states, **delete `AgentsView.tsx:69-116` hardcoded 6 entries** (they shadow the API) → enforces contract caps client-side BEFORE send (instructions ≤20,000 tighter of Engine 32,768 `validation.ts:46` / contract 20,000 `v1.schema.json:42`; models ≤16; tools ≤32; history 1..100 default 30; retrieval 1..20 default 5) → closes `G-2`.
- [ ] **M2.2** Create — `POST …/assistants ({template} xor {definition})` → `frontend_implementation_plan.md:155`, `agent-setup.md:39` → keep `AgentsView.tsx:367` + `AgentEditor.tsx:86` but enforce `{template}` vs `{definition}` xor at form level (409 `owner_already_present`/`ownership_cap_reached` with fix guidance verbatim).
- [ ] **M2.3** Versions list / create draft — `GET/POST …/:id/versions` → `frontend_implementation_plan.md:156`, `agent-setup.md:24` → fix `useSaveDraftVersion` `useAgentAuthoring.ts:387-400`: post **top-level** per `CreateVersionDto` (`dto.ts:80-99` / `dto.ts:111-130` — four policies + `instructions` + `model_params` + `budget_policy` at top level, NOT nested `{definition}`) → validation failure eliminated → closes `G-3`.
- [ ] **M2.4** Draft edits with OCC — `PUT …/:id/versions/:v/draft` with required `If-Match: <hash>` (stale → `412 precondition_failed` + `expected/current` hashes, merge-or-reload; same-hash retry succeeds) and `DELETE …/draft` discards `DRAFT`-only, audited (`assistants.controller.ts:135-171`, `assistants.service.ts:375-438`, `draftWriteMissError:1393-1406`) → `frontend_implementation_plan.md:156`, `agent-setup.md:73,102-109` → races never clobber, discard removes DRAFT only, caps + unknown-keys + secret-shape validation mirrors create.
- [ ] **M2.5** Publish / rollback / retire — `POST …/versions/:v/publish`, `POST …/rollback`, `POST …/versions/:v/retire` live (`AgentDetailView.tsx:476,388,518`) → `frontend_implementation_plan.md:157`, `agent-setup.md:73,79-80,90` → add `BLOCK`-gate surfacing: publish `422 BLOCK — resolve the critical failures and re-evaluate` (+ `required_checks` variant) with decision reason → link eval run (`decision` PASS|WARN|BLOCK latest-wins; `WARN` blocks only where template declares required checks) + retired read-only treatment + unresolved pins `REFUSE` `422 unresolved knowledge sources cannot publish: <slugs>` (`assistants.service.ts:1208-1216`) unless `acknowledge_degraded_knowledge: true` in body (audited `assistant.publish_degraded_acknowledged` `assistants.controller.ts:173-187,235-247`), banner fix path (map docs or acknowledged bypass).
- [ ] **M2.6** Export / import / snapshot / provenance — `GET …/export`, `POST …/versions/import`, `GET …/snapshot`, `GET …/provenance` → `frontend_implementation_plan.md:158`, `agent-setup.md:79` → `AgentDetailView.tsx:359` import-draft exists → add file download (export deterministic with `schema_version`), file-pick validated import (reversible with snapshot), provenance timeline view (template `slug@version` + `definition_hash`, manifest hash, snapshot binding).
- [ ] **M2.7** Test-run / evaluate — `POST …/versions/:v/test-runs`, `POST …/versions/:v/evaluate → eval_run_id` → `frontend_implementation_plan.md:159`, `agent-setup.md:78,84` → new buttons on version row; test-run opens chat pinned to version (`run_kind='test'` no quota/billing); evaluate links to §4.7 run detail (rubric bar ≥9/10 0 critical fails, per-case `must_not`/`tools_expected`, `decision` with provenance link).
- [ ] **M2.8** Disable / enable / delete — `POST …/disable`, `POST …/enable`, `DELETE …` → `frontend_implementation_plan.md:160`, `agent-setup.md:79` → `AgentDetailView.tsx:306` delete exists, owner/admin only, tombstone-aware 404 copy on deleted assistant.
- [ ] **M2.9** Rollout + releases — `GET/POST …/rollout`, `POST …/rollout/pause`, `GET/PUT …/releases` → `frontend_implementation_plan.md:161`, `agent-setup.md:81-82,86,107` → rollout editor (pause/resume) + release-pointer table `environment × channel` (`assertAssistantRoutable` channel-addressable errors) + weighted variants `1–10` versions positive-integer weights summing to exactly `100` sticky per conversation (built-in A/B + canary) + **paused banner** `paused_reason/by/at` verbatim (manual = actor, burn-rate = `reason+costs`, `NULL` = `operator-paused-legacy` `assistants/schema.ts:175-177`) + degraded banner from `GET …/:assistantId/knowledge-health` per-pin `slug/resolved/state` + `degraded` over `ACTIVE` pins (`assistants.controller.ts:122-127`, `assistants.service.ts:477-510`). Burn-rate is **service-only** (`billing.burn_sweep` hourly `billing.worker.ts:61-119`; `BurnRateService.isSuppressedByManualResume` `burn-rate.service.ts:89-144`, `BURN_RATE_RESUME_COOLDOWN_SECONDS` `env.ts:97`) — operate UI surfaces state + audit, never a burn endpoint.
- [ ] **M2.10** Control blocks — `GET/POST/DELETE …/control-blocks` → `frontend_implementation_plan.md:162`, `agent-setup.md:81,86` → kill-switch table five levels (`assistant|version|tool|template|capability`, `reason`, `expiry` — no warn mode, expiry needs no worker), `BLOCK` creates here surface on publish, owner/admin only; assistant kill flag blocks acceptance within one run cycle, audited.
- [ ] **M2.11** Authoring-field mappings — single module `useAgentAuthoring.ts` per `frontend_implementation_plan.md:164`, `agent-setup.md:72` → `never→optional/none`, `on_effect|always→required` + catalog `REQUIRED`; `memory_scope org→organization` (Engine `user` has no consumer — omit); `max_context_tokens`/`retrieval_policy`/`brand` are contract/consumer-side never Engine version fields; tool entries `{name, access, approval, schema_hash?}` only (effect class on catalog row `tool-catalog.schema.ts:47-48`). Tool name `^[a-z][a-z0-9_]{1,63}$`, `input_schema` ≤16 KiB. Studio validator 7 classes + `COMPILER_VERSION` (`agent-definition` package) mirrored in template CI order: Studio first, Engine second.
- [ ] **M2.12** Knowledge-first funnel UX — `agent-setup.md:36-46,50-57` → `INSTALL → CONFIGURE → MAP KNOWLEDGE → TEST-RUN → EVALUATE → PUBLISH → OPERATE` funnel, explicit audited transitions, nothing auto-publishes, in-flight runs stay pinned to superseded versions, per-assistant observe: `assistant_*_daily` rollups `GET …/analytics/rollups?kind=&days=&assistant_id=` (containment `completed ÷ (completed+escalated)` null on empty, CSAT up/down/ratio, runs/tokens/cost) + briefed handoff (immutable brief-at-escalation).

#### Exit gates — M2

- [ ] No valid definition is routable through the dropped nested-`{definition}` shape (G-3 closed, grep `definition:` in `useSaveDraftVersion` shows top-level policies).
- [ ] Concurrent saves never clobber: stale `If-Match` → `412` with both hashes, same-hash retry succeeds, `DELETE draft` removes `DRAFT` only (manual 2-tab race).
- [ ] Publish/rollback refuse unresolved pins with `422` + slugs, accepted bypass audited as `assistant.publish_degraded_acknowledged`; `BLOCK` publishes refused with decision reason → eval link.
- [ ] In-flight run remains pinned to original snapshot after new publish (pinned-run repro).
- [ ] Blocked version unassignable in rollout/release; kill switch blocks acceptance ≤1 run cycle.
- [ ] Caps pre-checked client-side (instructions/models/tools/budgets) with `422 unknown keys rejected: <dotted paths>` + `tool pins rejected` + `allowed_models not present` / `residency not served` rendered with fix paths; secret shapes rejected before persistence.

---

### Phase M3 — Templates + Tools / Models / Credentials (`frontend_implementation_plan.md:166-175`, `agent-setup.md:59-68`)

*Objective: template gallery actually installs; provider trust is eyes-visible (fingerprints only, step-up-gated writes).*

- [ ] **M3.1** Wire templates (closes flagship gap `G-1`) — `TemplatesView.tsx:157` toast-only → `frontend_implementation_plan.md:168`, `agent-setup.md:59` → `GET …/assistant-templates` (badges `installed`/`update_available` via `checkUpdates`) → detail `GET …/:slug?version=` with BOM tabs (definition / tool bindings incl. `effect_class` + `approval_requirement` + `when_to_use` / knowledge `required[]` + seeds + `channels`+caps / eval rubric + `release_policy.yaml`) → **Use template** = `POST …/assistants {template: {slug, version}}` (+ optional name; duplicate → `409`) → navigate to created assistant; enforce `min_engine_schema` compatibility client-side (disable + reason when unmet). No template editing in console (BOMs versioned `products/agent-studio/templates/`, linted `neryva-template lint`). Updates via `checkUpdates` comparison drives banner; drift reads `installs.templateVersion + snapshot templateRef{slug,version,definition_hash}` vs registry.
- [ ] **M3.2** Wire tools — `GET/PUT …/tools`, `GET …/tools/templates`, `POST …/tools/from-template`, `GET …/tools/:name`, `PATCH …/tools/:name/enabled` → `frontend_implementation_plan.md:172` → editor validates name + `input_schema` ≤16 KiB depth ≤32 (`tool-catalog.service.ts:42-70`), credential shown **never** (sealed `enc:v1:` server-side, `GetToolCredential` scoped MCP op `run.proto:368`), enabled-toggle owner/admin only, reads all-ish.
- [ ] **M3.3** Wire models — `GET …/models` → `frontend_implementation_plan.md:173`, `agent-setup.md:66` → per-model compatibility reasons rendered as inline disable-reasons in authoring picker (usable + `required_model_capability_missing` reasons).
- [ ] **M3.4** Wire provider credentials (two-tier govern) — `GET …/provider-credentials` fingerprints-only list (assert no secret material in responses during QA `frontend_implementation_plan.md:174`), `POST` BYOK owner/admin + **fresh MFA proof** (`StepUpGuard`, revoke proof-free `agent-setup.md:65,86,109`), `POST …/rotate`, `POST …/revoke`, provider enablements `GET/PUT` (`default on`). Published `model_catalog` allowlist (entries, fallback order, regions, cost ceilings) + residency pin `default|eu` fail-closed + trial caps/budgets view (`agent-setup.md:65`). Staff provider-plane `/internal/staff/...` never linked.
- [ ] **M3.5** Clean `G-7`/`G-8` — `ModelsView.tsx:87` auto-routing toggle → wire to real Engine field or delete the toggle (`model-catalog.controller.ts:18`); verify no secrets rendered anywhere.

#### Exit gates — M3

- [ ] `TemplatesView → detail → Use template` creates via `POST …/assistants {template}` and lands on the new assistant; `min_engine_schema` mismatch disables with reason; no toast-only path remains (G-1 closed).
- [ ] Tool create shows `when_to_use` from template BOM, validates `name` regex + `input_schema` size flag, never renders `enc:v1:` material.
- [ ] Model picker shows per-model disable reasons, not generic "unavailable".
- [ ] Provider credential list is fingerprints-only (grep `enc:v1` zero in list responses); create/rotate without fresh MFA proof → `step_up_required` → MFA modal → single retry; revoke stays proof-free.
- [ ] `G-7` + `G-8` grep gates pass (or toggle is wired).

---

### Phase M4 — Knowledge / memory / connectors / eval (`frontend_implementation_plan.md:176-183`, `agent-setup.md:50-58,77,82`)

*Objective: upload→READY pipeline observable; doc source-ACL provenance visible; connector sealed material never leaks; eval queue off toast.*

- [ ] **M4.1** Wire uploads — `POST …/uploads {purpose, media_type, byte_length, sha256, source_slug?, title?}` → presigned POST (exact size/sha window) → direct PUT → `POST …/uploads/:id/complete` (server verifies bytes + bound sha via `headObject`) → stage polling `GET …/uploads/:id`: `CREATED→UPLOADING→UPLOADED→SCANNING→EXTRACTING→INDEXING→READY` / `QUARANTINED`/`FAILED` with reason copy → `frontend_implementation_plan.md:178`, `agent-setup.md:52` → extend `useAttachmentUpload.ts` (exact content-length, checksum binding, multipart above threshold, abort-stale), title defaults to slug else auto, slug `kebab 3–64` reserved → `409 source_slug_taken` verbatim.
- [ ] **M4.2** Wire documents inventory + mapping — `GET …/documents` (slug/title/state/latest version newest first) + `POST …/documents/:id/source-slug` (owner/admin/developer, audited, `409` on collision; old pins referencing prior slug resolve visibly unresolved next publish — history never rewritten) + `GET …/documents/search?query&limit` (`limit` clamp `1–20` documented; `READY`-only server-enforced `frontend_implementation_plan.md:179`) → `agent-setup.md:53` → list/search state badges (`processing|ready|failed|retired`).
- [ ] **M4.3** Wire degraded/mapping UX — `GET …/:assistantId/knowledge-health` per-pin `slug/resolved/state` + `degraded` over `ACTIVE` pins (`assistants.controller.ts:122-127`) → `frontend_implementation_plan.md:179,161` → operate-view degraded banner; pre-publish required-slug→READY-doc mapping before publish attempt (explicit task beyond `ACTIVE`-only health — consider `?version_id=` or `:versionId/knowledge-health` if editor needs draft preflight, `backend_gaps.md` folded `R-1`).
- [ ] **M4.4** Wire memories — `GET …/memories?scope_type&scope_id`, `POST …/memory-proposals/:id/decision` (approve/reject), `DELETE …/memories/:id` soft-delete → `frontend_implementation_plan.md:180`, `agent-setup.md:86` → proposals queue is explicit view (nothing auto-accepts), scope `user|organization|conversation|none` with `org→organization` mapping.
- [ ] **M4.5** Wire connectors — `GET/POST …/connectors`, `POST …/:accountId/{state,sync}` + OAuth apps/dance `GET/POST …/connector-oauth-apps` + `GET …/connectors/:provider/callback` (public, rate-limited) → `frontend_implementation_plan.md:181`, `agent-setup.md:54-56` → sitemap (no auth) + Drive (per-org OAuth dance auto-refresh with skew) + SharePoint/Confluence/Notion/Zendesk/Slack (sealed static `enc:v1:` shape-validated at link, Dance pointer on Drive secret paste), bounded fetch (pagination + iteration caps, per-doc `skipped` with reasons never sync failures), mapping-aware versioning (no duplicates), tombstones `retired` on source deletions (mapping kept). List responses show `hasCredentials` only, never sealed material.
- [ ] **M4.6** Surface permission-sync provenance — `agent-setup.md:55` adapters capture source verdicts (Drive/Graph `anyone/domain` open else principals; Confluence restrictions; Zendesk segments; Slack public-share; Notion workspace-scoped open) → ingestion upserts principals + auto-links `external_identity_links` on email equality + replaces per-doc allow-lists `retrieval_acl`/`document_source_acls` → retrieval admitted per `agent-setup.md:55` (restricted docs only to linked/verified, anonymous sees unrestricted, unknown default-deny, inside `WHERE` never post-filtered). Console displays per-doc ACL badge (restricted vs open) and lineage where available.
- [ ] **M4.7** Wire eval (replace `EvaluationsView.tsx:70` toast) — datasets/cases/runs/results/promote/reject/recall endpoints (`harness-parity.controller.ts:27-180`) → `frontend_implementation_plan.md:182`, `agent-setup.md:77` → run detail shows rubric bar (`≥9/10, 0` critical fails), per-case `PASS/FAIL` with `must_not`/`tools_expected`, quality gates (`WARN`-only thresholds `task_success/groundedness/policy_compliance`), `decision PASS|WARN|BLOCK` + provenance (`dataset_id + case count hash`, `evaluator versions`, `model/provider+hash`, `tool catalog hash`, `knowledge pins+embedding model`, `guardrail hash` + `COMPILER_VERSION`, `seed`, `started/complete/by`) with link back to version via `assistant evaluate → eval_run_id`, plus datasets/cases CRUD.

#### Exit gates — M4

- [ ] Upload → presigned PUT → `complete` → polling reaches `READY`; oversize/`QUARANTINED`/`FAILED` reason rendered; re-ingest appends version via `target_document_id`.
- [ ] Documents list/search respect `limit` clamp `1–20`; `READY`-only server-enforced; `POST source-slug` `409` collisions surfaced with rename fix.
- [ ] `knowledge-health` degraded flag drives both post-publish banner and pre-publish mapping view.
- [ ] Connector list never contains `enc:v1:` (grep zero); seal errors copy verbatim; tombstoned docs `retired` but mapping retained.
- [ ] Memories queue shows `scope_type` correctly, approve/reject/delete all audited.
- [ ] Eval `G-6` closed: queue → detail → rubric bar → decision + provenance link functions; no toast-only path remains.

---

### Phase M5 — Conversations / chat / SSE / runs / approvals / escalations (`frontend_implementation_plan.md:184-191`, `agent-setup.md:81-82`)

*Objective: cursor pagination never duplicates on reconnect, SSE resumes identically, human-in-loop queues are discoverable and actionable within one click of chat.*

- [ ] **M5.1** Wire conversations — `GET …/conversations?limit&assistant_id=` (+ detail, `POST …/status` with `expected_version` conflict copy `412` `precondition_failed` + `expected/current` hashes, `POST …/status` `expected_version` conflict, `POST …/messages` body `dto.idempotency_key` + `Idempotency-Key` header both accepted — `useChat.ts:320-367` flow stands, `regenerate`/`edit` same, message `pin`, `feedback`, `title` PATCH, `shares` create/list/revoke token shown once + copy, `export` markdown slice note) → `frontend_implementation_plan.md:186` → cursor pagination `after → next_cursor` (never page numbers except members `limit/offset`), stable under concurrent inserts with `EXPLAIN` captured on list query.
- [ ] **M5.2** Harden chat view — `AgentStudioChatView` + `useChatSession` keep `accepted→runId→SSE` pattern (`useChat.ts:290-367`) → `frontend_implementation_plan.md:187` → harden 15s `accepted`-fallback copy + coalesced assistant text + tool notices + usage notices + terminal `finalize` + query invalidation on terminal (`chat-messages`/`chat-runs`/`chat-events` via `['org', orgId, …]` prefix).
- [ ] **M5.3** Wire runs — `GET …/runs/:runId`, `GET …/events?after_sequence&limit` (history), `SSE …/events/stream` with `Last-Event-ID` resume (`useEventStream` `sse.ts:190-235` reconnect backoff+jitter) + `POST …/cancel`, `POST …/result` (CommitRunResult — developer+ only, confirm modal), `POST …/capability` never displayed (mint-and-use internally; if shown anywhere, remove) → `frontend_implementation_plan.md:188` → on terminal event: finalize transcript, invalidate `chat-messages`/`chat-runs`, stop reconnecting after grace; slow-consumer → drop to history-refetch `GET …/events?after_sequence=` rather than unbounded buffer (`frontend_implementation_plan.md:221`).
- [ ] **M5.4** Wire approvals — `GET …/approvals?state=`, `POST …/approvals/:id/extend`, decision via `POST …/runs/:runId/approvals/:approvalId/decision` (`APPROVED/DENIED` + one-time decision idempotency `Idempotency-Key`) → `frontend_implementation_plan.md:189` → waiting runs surface in chat + dedicated queue view (badge + due timer), `extend` + decision both toast via `describeEngineError`.
- [ ] **M5.5** Wire escalations — full claim/assign/resolve/reply flow (`escalations.controller.ts:22-128`), human-handoff entry from chat → `frontend_implementation_plan.md:190` → queue + detail + reply composer; `briefed handoff` packet (summary + open run + last customer message) immutable at escalation.
- [ ] **M5.6** Surface per-assistant containment + knowledge gaps — `agent-setup.md:82` → `assistant_*_daily` rollups + knowledge-gap loop (eval misses + low-score legs `retrieval.service.ts:54-200` + `run_judgments` → new-doc tasks) as next-build console affordance on existing events (no new Engine work this ledger).

#### Exit gates — M5

- [ ] `after → next_cursor` stable under concurrent inserts; `limit` ≤100 (conversations) respected.
- [ ] SSE disconnect/reconnect with `Last-Event-ID` replays identically (no missing or duplicated authoritative event in client projection — `sse.ts:190-235`).
- [ ] `accepted` without `runId` within 15s renders fallback copy (not spinner-forever).
- [ ] Approvals waiting state visible in both chat inline and queue view; decision idempotency holds on double-click.
- [ ] Escalation claim/assign/resolve/reply full loop passes with audit.

---

### Phase M6 — Money / compliance / governance completion + cleanup (`frontend_implementation_plan.md:192-198,212-214,246-249`)

*Objective: money/compliance never rebuild what already exists in `/platform`; wire what's missing, gate what the server gates.*

- [ ] **M6.1** Wire usage/billing — usage overview/series/rollup + `GET …/usage/ledgers` → `invoices/credits/budgets/adjustments/usage-export` (`billing worker hourly billing.burn_sweep`, `SpendIngestService`, `usage-ledger.consumer.ts` are platform-only; console surfaces rollups + ledgers + invoices) → `UsageBillingPages.tsx`, `UsageView.tsx`, `AnalyticsView.tsx` already mostly built — complete, don't rebuild → `frontend_implementation_plan.md:194` → usage-export respects 10k note, invoice `draft→issue→pay→void` gated by `owner|admin` + billing role matrix.
- [ ] **M6.2** Wire audit — `GET …/audit`, facets, `GET …/audit/export` NDJSON (one-time token), `GET …/audit/verify` chain (`verifyChain` green for bounded window) → `AuditPage`, `ComplianceView.tsx:604` → `frontend_implementation_plan.md:194` → `audit_events` survive ordinary row deletion, `data_access_records` separate stream.
- [ ] **M6.3** Wire lifecycle — `GET/POST …/retention/policies`, `GET/POST …/legal-holds`, `POST …/exports` (point-in-time manifest, encrypted, one-time download), `POST …/purge` tasks via `purgeTasks` + holds + tombstones → `ComplianceView.tsx`, `useLifecycle.ts`, `useConfigLifecycle.ts` → `frontend_implementation_plan.md:194` → legal hold blocks purge for covered scope while unrelated retention still runs; export never includes another tenant; `verifyChain` + hold/purge evidence report gates.
- [ ] **M6.4** Wire webhooks — `GET/POST …/webhooks`, `GET …/:id/deliveries`, `POST …/:id/test`, `POST …/:id/rotate`, `PUT …/:id` → `useWebhooks.ts`, `WebhooksView.tsx` → `frontend_implementation_plan.md:194` → note Engine has **no** `@Idempotent` on `update/rotate/test`, so UI must still send keys + `disable-while-pending` (server treats unknown keys as new — safe).
- [ ] **M6.5** Complete teams/settings — members/invites/groups/service-accounts/projects/keys (`TeamsView.tsx`, settings tabs, `ApiKeysPage.tsx` — key secret shown once + copy, rotate/revoke with `StepUpGuard`) + sessions/MFA/account-deletion (`SettingsSecurity.tsx`, `SettingsProfile.tsx` already comprehensive) → `frontend_implementation_plan.md:194` → suspend-before-remove offboarding, role matrix enforced, impersonated sessions read-only.
- [ ] **M6.6** Channels — `channels.controller.ts`, `templates.controller.ts`, widget plane (`widget.controller.ts`) ship in **last** Studio milestone only if release needs them — template `channels` bindings display as read-only until then → `frontend_implementation_plan.md:196`.
- [ ] **M6.7** Close `G-7`/`G-8` — `ModelsView.tsx:87` auto-routing toggle → wire to real Engine field or delete (`model-catalog.controller.ts:18`); `AgentStudioShell` `@neryva_data` import already removed in M1.1 double-proven → `frontend_implementation_plan.md:212`.
- [ ] **M6.8** Dormant deployment shell — hide `/deployment` nav + deep-link cards behind build flag (default off), keep routes mounted (no 404 regressions for bookmarked URLs — render `_coming soon_` state) → `frontend_implementation_plan.md:247-248` → zero wiring work, no deployment acceptance criteria this ledger.

#### Exit gates — M6

- [ ] Usage series/rollup + ledgers + invoices render from Engine truth; no client-computed usage/price.
- [ ] Audit facets + NDJSON export + `verifyChain` pass; lifecycle export download is one-time token.
- [ ] Webhooks test delivery proves `disable-while-pending` + `Idempotency-Key` (no duplicate delivery on retry).
- [ ] `G-7` toggle either wired or deleted (grep gate); `G-8` grep zero.
- [ ] `/deployment` hidden behind flag, bookmarked route renders `_coming soon_` not 404.

---

## 5. Global invariants + quality gates (hold M0→M6)

*Cross-cutting standards `frontend_implementation_plan.md:218-228` + `README.md:41-48` — no exceptions, checked every milestone.*

- [ ] **INV-1** Transport: `engine<T>()` only (`client.ts:16-24` same-origin `/engine` proxy + `VITE_ENGINE_URL` exotic only); `credentials:'include'` always; `X-Neryva-Org` from `OrgProvider` (`client.ts:150-153`); `Idempotency-Key: <uuidv7>` on every mutation (`frontend_implementation_plan.md:219`); `X-MFA-Proof` via `stepup.ts` `runWithStepUp`; `{error:{code,…}}` → `ApiError` → `describeEngineError` → tone/title/action/retryable (`errors.ts`).
- [ ] **INV-2** State: React Query owns server state (`staleTime 5min` baseline `main.tsx:15-32` stands; shorten to ~15s for run/approval queues, `no-cache` for audit-verify); zustand owns session/org/UI prefs only; no fetched data in zustand; query keys always `['org', orgId, …]` so org-switch invalidation is one prefix.
- [ ] **INV-3** Streaming: `useEventStream` everywhere; reconnect backoff+jitter + `Last-Event-ID` already in `sse.ts:190-235`; on terminal: finalize transcript, invalidate `chat-messages`/`chat-runs`, stop reconnecting after grace; slow-consumer → history-refetch not unbounded buffer.
- [ ] **INV-4** Forms: controlled inputs, schema validation mirroring Engine bounds (contract caps `agent-setup.md:71` + tool name regex `^[a-z][a-z0-9_]{1,63}$` + `input_schema` 16 KiB), server `422` renders field errors never generic toast, dirty-guard on navigate-away for agent editor, `unknown keys rejected: <dotted paths>` + `tool pins rejected` + `slug_taken`/`source_slug_taken` verbatim.
- [ ] **INV-5** Files: object keys never use user filenames (server binds them `storage.service.ts:43`); client sends exact `byte_length` + `sha256` it computed; MIME allowlist error comes from server `403 artifact content type is not allowlisted`, not a client list.
- [ ] **INV-6** Security: no secret material rendered (provider credentials fingerprints-only `provider-credentials.controller.ts`, API keys/shares/proof secrets shown once + copy + never re-fetchable); `rel=noopener` on `docs_url`/external; no `dangerouslySetInnerHTML` for server content (markdown export sanitized); CSP `form-action 'self'` preserved; session tokens never in `localStorage` (`neryva.pending_invite` invite-stash excepted, short-TTL single-purpose).
- [ ] **INV-7** A11y/i18n: keyboard-reachable dialogs/menus, focus-trap in modals (step-up, publish-confirm, destructive), `aria-live` for stream-appended chat + toast region, visible focus, contrast-checked status colors (terminal/failed/quarantined never color-only). English-only this release, no i18n framework until second locale committed.
- [ ] **INV-8** Telemetry: Web-vitals + route-level error counts + SSE reconnect counts to existing OTel pipeline; no PII in analytics events (org/actor ids hashed or omitted per Engine policy `tracing.ts`, `logger.ts` redaction).

#### Quality gates — every milestone must pass

- [ ] `pnpm typecheck && pnpm lint && pnpm test` green (vitest suites incl. `useStudioConversations/useOnboarding/useNotifications/useStudioStatus` + `NotificationsPopover` stay green; new hooks/views ship with tests) — `frontend_implementation_plan.md:238`.
- [ ] No `src/api` axios imports outside 3 public forms (grep gate), no `localStorage` tokens (grep gate), no `@neryva_data/products/*` in app shells (grep gate) — `frontend_implementation_plan.md:239`.
- [ ] Contract check: all consumed paths exist in composed Engine OpenAPI (`scripts/export-openapi.ts` artifact); added query params match server clamps (documents `limit` 1–20, conversations `limit` ≤100, usage-export 10k) — `frontend_implementation_plan.md:240`.
- [ ] Manual QA scripts pass per milestone: OAuth round-trip, org switch, agent create→version→publish→chat→approve→terminal, template install, upload→READY, proposal decision, invoice draft→issue, audit export+verify, lifecycle export one-time token, webhook test delivery, SSE disconnect/reconnect identical replay — `frontend_implementation_plan.md:241`.
- [ ] Red-team pass: cross-org `:orgId` swap →403, direct-link to admin action as reader (hidden+denied), replayed `Idempotency-Key` with different body →409, stale `expected_version` → conflict no data loss, share-token URL uniform 404 when invalid — `frontend_implementation_plan.md:242`.

---

## 6. Engine prerequisites folded from deleted `backend_gaps.md` (track here, own there)

*`backend_gaps.md` (B-1..R-4, OPEN 2026-09-15) was the frontend-derived input register reading `engine/src` against the flows above. Folded here so no gap is lost; each maps to an Engine task already owned by `release_gap_report.md` / `release_ledger.md` — frontend blocks until Engine lands it.*

| ID | Gap | Engine owner | Frontend blocked | Status after `fa947e3` |
|---|---|---|---|---|
| **FE-B1** | Authoring payload whitelisted → `instructions`/`model_params`/`budget_policy` 400 on `POST …/versions` / `import` (nested `{definition}` vs top-level) | `dto.ts:111-130` + `dto.ts:147-170` + `assistants.service.ts:342-406` + `validation.ts:43-49` | M2.3/M2.4 draft saves fail validation; export→import round-trip fails | **ENGINE DONE** `fa947e3` — DTOs widened + `PUT …/draft` + `DELETE …/draft` with OCC `412` + strict parity |
| **FE-B2** | Artifact claim-check no console caller (`ArtifactsService.dereference` `artifacts.service.ts:294-349` has 7 gates but no `GET console/org/:orgId/artifacts/:id`) | `knowledge/artifacts.service.ts` + `knowledge.controller.ts:63` | M4.1/M5.1 uploads/attachments never readable | **OPEN** — Engine must add `GET console/org/:orgId/artifacts/:artifactId → {access_url 300s, expires_in, content_type, byte_length, sha256}` (never `object_key`), roles `MESSAGE_ATTACHMENT`/`GENERATED_MEDIA` all-ish, `SOURCE_DOCUMENT` owner/admin/developer |
| **FE-B3** | Conversations list no cursor/no preview/no `run_kind` filter (only `limit`+`assistant_id` `conversations.controller.ts:49`/`conversations.service.ts:153`; test-runs pollute inbox) | `conversations.controller.ts:49` + `conversations.service.ts:153` + `runs.runKind standard|test|eval` `schema.ts:92,116` | M5.1 inbox unusable at scale; no `run_kind` split | **OPEN** — Engine `listConversations` needs `run_kind` default `standard`, `status` default `active`, `after` cursor + `q` + indexed projection `last_message_at/preview/open_run_state/pending_approvals/escalation_state` |
| **FE-R1** | No pre-publish knowledge preflight (`knowledge-health` ACTIVE-only `assistants.service.ts:477`) | `assistants.controller.ts:118-127` | M2.5/M4.3 editor can only discover pins by failing publish `422` | **OPEN** — add `?version_id=` or `:versionId/knowledge-health` so draft required-slug→READY mapping shows pre-publish |
| **FE-R2** | Stale `neryva.active_org` → plain `403` with no recoverable code | `org-roles.guard.ts:38-44` + `GET console/org/contexts` | M1.2/M1.6 any org-scoped request soft-bricks | **OPEN** — decide: Engine stable code `org_access_revoked` or console `on 403 → re-fetch contexts → switch to first`, then test + error catalog |
| **FE-R3** | Notification `data.target` incomplete (`org.member_removed`/`suspended` only `{org_id}` `:149,:160`, `billing.anomaly` only `{product,day}` `:67`) | `notifications/schema.ts:24` + `notifications.service.ts:60-204` | M1.3/M4.7 deep-links broken per kind | **OPEN** — pin `data.target={kind,id}` per kind, table-tested |
| **FE-R4** | No `assistant.draft_ready` on draft create/update (only audit `assistant.version_drafted` `:354`, no `assistant.*` notification kind) | `assistants.service.ts:354` + `notifications.service.ts` | M2.7 dev→admin handoff never resumes | **OPEN** — emit `assistant.draft_ready {assistant_id, version_id, hash}` to owner/admins per draft revision (coalesce autosave storm) or record "manual until console supports handoff" in `agent-setup.md` |

*When an FE-B/R lands, flip status here with commit ref and cross-link to `release_gap_report.md`.*

---

## 7. Traceability — nothing missed

*Every spec section maps to at least one ledger ID. A section with no ledger ID is a spec bug — file an issue, don't silently skip.*

| Spec | Section | Ledger IDs | Notes |
|---|---|---|---|
| `frontend_implementation_plan.md` | §0 invariants 1–6 | INV-1..8, M0.6-0.8 |  |
|  | §1.1 current state keep/fix | M1.1, M1.4, M6.8 |  |
|  | §1.2 auth dual-stack | M0.1-M0.8 |  |
|  | §1.3 Engine inventory | M2.2-2.12, M3, M4, M5, M6 | per-row cited |
|  | §3 auth migration 3.1-3.4 | M0.7-0.8, M0 exit gates |  |
|  | §4.1 shell/home/onboarding/status/notifications | M1.2-1.3 |  |
|  | §4.2 agents lifecycle + mappings | M2.1-2.12 | G-2,G-3,G-4,G-5 consumed |
|  | §4.3 templates | M3.1 | G-1 |
|  | §4.4 tools/models/credentials | M3.2-3.5 | G-7 |
|  | §4.5 knowledge/memory/connectors/eval | M4.1-4.7 | G-6 |
|  | §4.6 conversations/runs/SSE/approvals/escalations | M5.1-5.6 |  |
|  | §4.7 usage/billing/audit/lifecycle/webhooks/teams/settings + channels | M6.1-6.6 |  |
|  | §5 G-1..G-10 | M1.1 (G-8), M2.1 (G-2), M2.3 (G-3), M2.11 (G-4,G-5), M3.1 (G-1), M4.7 (G-6), M6.7 (G-7,G-8), M6.8 (G-10) + M0.4 (G-9) |  |
|  | §6 cross-cutting standards | INV-1..8 |  |
|  | §7 static pages | M1.4 |  |
|  | §9 deployment dormant | M6.8 |  |
|  | §8 quality gates | Quality gates |  |
|  | §10 milestones M0→M6 | Phase overview + M0→M6 |  |
| `first-run-onboarding.md` | §0 decision + §1 Flow A | M1.5 | display_name + workspace name `Promise.allSettled` |
|  | §2 Flow B invite path | M1.6 | stash + preview body + redeem + active-org |
|  | §3 edge cases (7 rows) | M1.7 |  |
|  | §4 NOT build | M1.5-1.7 guards |  |
|  | §5 acceptance (6) | M1.5-1.6 + M1 exit gates |  |
|  | §6 locked decisions (4) | M1.9 + README INV | value-first trial, user project, template-first |
| `team-loop.md` | §0 six answers + §1 invite creation | M1.6 + M6.5 | `INVITABLE_ROLES`, one-owner index `drizzle/0044` |
|  | §1A delivery methods | M1.8 | `delivery manual|email`, `accept_url` shown once |
|  | §1B share UX | M1.8 | Copy + `mailto:` draft |
|  | §2 email notes | M1.8 |  |
|  | §3 accept flow + preview POST | M1.6 | `POST …/preview` body token, `logger.ts:8,18-58` redaction |
|  | §4 role matrix (owner/admin/…) | M6.5 | `OrgRolesGuard` + `EntitlementGuard` |
|  | §5 new-member dashboard | M1.2 |  |
|  | §6 acceptance (9) | M1.6, M6.5 |  |
|  | §7 deferred SCIM/etc | M6.5 |  |
|  | §8 Engine work-list 3 items | M1.6/M1.8 (IMPLEMENTED `adee441+885fe36+bc8bd82`) |  |
| `agent-setup.md` | §0 direct answers 1–4 | M2.9, M4.2, M3.1, M3.4 |  |
|  | §1 data model (exact) | M2.1-2.12 | `assistants`, `assistant_versions`, `policy_snapshots`, `run_manifests`, `documents→chunks→embeddings`, `control_blocks`, rollups |
|  | §2 funnel | M2.12 | `INSTALL→…→OPERATE` |
|  | §3 Slice A knowledge | M4.1-4.6 | uploads/slug/connectors/sync/tombstones/permission+pin E-1 |
|  | §4 Slice B template install | M3.1 | provisioning outbox retryable |
|  | §5 Slice C providers | M3.4 | BYOK + residency + catalog + step-up |
|  | §6 Slice D authoring reference | M2.11 | caps/mappings/3 gates |
|  | §7 Slice E test→publish→operate | M2.7-2.10 | test-run `run_kind='test'`, BLOCK latest-wins, rollout weights, burn cooldown, knowledge-health, briefed handoff |
|  | §8 endpoint+role table | M2.1-2.12, M3.1-3.5, M4, M5, M6 |  |
|  | §9 error catalog | INV-4 | `slug_taken`, `unknown keys`, `tool pins`, `BLOCK`, `412` `precondition_failed`, `422 unresolved pins`, `step_up_required` |
|  | §10 locked (refuse + split) | M2.5, M2.9 | `REFUSE` `acknowledge_degraded_knowledge`, `SPLIT` emergency toggles |
|  | §11 out | — | no ledger work |
|  | Acceptance 7 items | M2.1-2.12, M4, M5 |  |
| `README.md` | canonical locations + locked decisions | INV-6, M0-M6 | `neryva.pending_invite` sole `localStorage` session exception |
| `backend_gaps.md` (deleted, folded) | B-1..B-3, R-1..R-4 | §6 FE-B1..R4 + M1.6, M2.3, M4.1, M5.1, M1.3, M2.7, M1.2 | FE-B1 closed `fa947e3` |

*Verification 2026-09-15: every spec citation re-checked against `engine/src` + `console/neryva-website/src` + `products/agent-studio` + `drizzle/*.sql`. Where the plan cites `dto.ts:80-99`, the working tree's range is `dto.ts:111-130` after `fa947e3` — same shape, tolerance noted.*

---

## 8. References

- `console/neryva-website/src/router/routes.tsx`, `src/router/root.tsx:37-62`, `src/lib/engine/{client,auth,sse,session-gate,errors,capabilities,stepup}.ts`, `src/hooks/studio/*` (21 files), `src/sections/pages/products/agent-studio/*`, `src/pages/platform/*` — console inventory (§1.1/§4 citations)
- `engine/src/modules/{assistants/*,knowledge/*,conversations/*,organizations/*,identity/*,console/*,billing/*,lifecycle/*,webhooks/*,notifications/*}` + `drizzle/*.sql` + `ownership-map.json` — Engine authority (plan §1.3/§4 citations, `agent-setup.md:111-115` references)
- `products/agent-studio/contracts/agent-definition/v1.schema.json` + `packages/agent-definition/{validator,compiler}` + `templates/registry.json` + `scripts/neryva-template-lint.ts` — authoring caps consumed in §4.2
- `docs/dev/agent_related/_agent_setup_detail_plan.md` — system gaps G-1..G-5 evidence (`TemplatesView/AgentsView/useSaveDraftVersion`/mappings)
- `docs/dev/agent_related/release_readiness/release_gap_report.md` + `release_ledger.md` — binding Engine gaps (GAP-xx/REL-xx); this ledger's FE-B/R map into them
- `docs/frontend/{frontend_implementation_plan.md,first-run-onboarding.md,team-loop.md,agent-setup.md,README.md}` — the 5 specs this ledger tracks
- `docs/architecture/engine/imp/ledger.md` — system phase gates (M0→M6 runs after Phase 0–10 engine gates pending the first full CI/DB run)

---

## 9. Milestone checklist (copy to PR description)

```text
M? — <ledger ID> — <one-line change> — spec § — evidence
- typecheck: pnpm -C console/neryva-website typecheck && pnpm -C engine typecheck
- lint: pnpm lint (0 errors; warnings triaged)
- test: pnpm test (vitest green; new hook/view has test)
- contract: scripts/export-openapi.ts composed, no drift on touched paths
- grep gates: no src/api outside 3 forms, no localStorage token, no @neryva_data in shells
- QA: <milestone QA script> manual pass (OAuth round-trip / org switch / agent create→publish→chat→approve etc.)
- red-team: cross-org :orgId swap →403, reader sees admin action as hidden+denied, replayed Idempotency-Key body-diff →409, stale expected_version → conflict, share-token invalid →404
```
