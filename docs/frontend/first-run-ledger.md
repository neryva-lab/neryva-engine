# First-Run Ledger — Welcome Screen, Invite Flow, Activation Instrumentation

> Status: BUILD COMPLETE 2026-09-16 (static-verified; live endpoint round-trips
> pending an engine restart — engine :3001 was down at build time, probes recorded
> in §7). No test files were executed during this build (standing instruction);
> pure helpers (`isFreshFirstRun`, stash, `parseActivation`) are written
> side-effect-free for unit coverage as follow-up.
>
> **F1-7 AMENDMENT (2026-09-17, shipped + live-verified): the freshness window is
> REPLACED by durable server state.** The 30-minute wall clock silently skipped
> the screen for the exact users it existed to serve — measured: the first social
> account completed its first console token exchange 75.8 minutes after creation
> (earlier logins died mid-flow in the social/token-CORS era), so the window had
> closed, `/platform/welcome` never rendered, and nothing could bring it back.
> The gate is now `account.onboarding.needed` from `GET /auth/me`, backed by the
> engine table `account_onboarding` (drizzle `0061`) + `POST
> /auth/me/onboarding/welcome`, which records MANDATORY consent. See §3 and §7.0.
> Owner: Frontend team + Engine platform team.
> Parent spec: `first-run-onboarding.md` (spec DONE 2026-09-15, decisions locked there).
> Scope: the three missing acceptance items — **F1** first-run screen, **F2** invite
> acceptance flow, **F3** activation instrumentation. Nothing else lands under this ledger.
> Non-goals: changing Engine creation semantics, billing/entitlement math, MCP contract,
> company-profile gates, client-side completion flags (all per parent spec §4).
>
> Gate rule: F1 → F2 → F3, in that order. F3 starts with spike SP-1 before any code.
> Every checkbox below flips only on merged, verified work — never on intent.
> Invariants (all features): browser never authoritative; Engine REST/JSON only;
> `engine()` sole transport; `Idempotency-Key: uuidv7` on mutations; `X-Neryva-Org`
> on org-scoped calls; no tokens in localStorage (the invite-token stash is the one
> deliberate exception — spec §2 rationale stands: short-TTL, single-purpose,
> email-bound, XSS already owns the session, CSP is the control).

---

## 1. Research basis (why each feature is shaped this way)

### 1.1 Orient → Activate → Expand (flow architecture)

Every B2B self-serve flow maps to three phases: **Orient** (signup → ~60s, user knows
the next step), **Activate** (2–15 min, user completes the activation event), **Expand**
(day 2–30, adjacent value + teammates). Routing/invite prompts belong at phase
boundaries: intent routing at end of Orient, team-invite prompts at start of Expand —
**after** the activation event fires, never before (early invite prompts inflate volume
without driving multi-user activation, the signal that predicts expansion revenue).

Mapping to this ledger: F1 is Orient (one screen, then dashboard + checklist). F2 is a
parallel Orient for invitees (land directly in value, no setup detour). F3 measures the
Orient→Activate transition. Billing details, company profiling, and advanced config
belong after activation — the parent spec §4 already excludes them.

### 1.2 Activation = one observable event, not a checklist

"Completed onboarding" is not an activation event. The industry definition that
predicts retention: **the smallest observable behavior that statistically predicts
month-3 retention** (Lenny Rachitsky / Yuriy Timen 500-product study; median
activation ~30–36%, healthy B2B 25–35%+, top quartile ~2.3× median). Locked decision
(parent spec §6): **first successful assistant run in the org (production OR
test-run)**. Consequences baked into F3:

- The event needs a **7-day conversion window** (windowless measurement counts a
  month-6 activation as a win — dishonest). Track signup→activation in-session AND
  within 7 days from day one.
- **Time-to-first-value (TTFV)** is the companion metric (median signup→activation,
  never mean). Top-quartile single-player self-serve lands first value inside
  5 minutes — the template → install → test-run path (parent spec §6) is the
  TTFV-critical path, which is why test-runs count.
- `GET /console/onboarding`'s `first_usage` step (spend-events row) is **rejected as
  an activation proxy**: test/eval runs skip billing by design, so the highest-value
  path would never register. F3 needs its own source (spike SP-1).

### 1.3 Invite redemption patterns (what good looks like)

- **Preview before identity**: the invitee sees workspace context (org name, role,
  inviter, expiry) BEFORE signing in. Our Engine already supports this via the
  anonymous preview endpoint (§2 contract) — better than Entra-style redeem-first
  flows that force authentication before showing anything.
- **Token discipline**: token travels in the email link (unavoidable) but every API
  call carries it in the POST **body**, never query (proxies/CDNs/history/logs record
  url+query). Our Engine enforces this shape already (`PreviewInviteDto`,
  `RedeemInviteDto` — body-only). The frontend must comply: read from URL once,
  stash, POST in body.
- **Claim-then-membership ordering**: membership write precedes the single-use claim
  so a seat-cap refusal leaves the invite usable (Engine does this —
  `invites.service.ts:267-287`). The client mirrors it: **retain** the stash on
  retryable outcomes, clear only on success/terminal.
- **No dead ends**: expired/revoked invites render an invalid screen WITH an exit
  ("Continue to my workspace") — a brand-new user already owns a personal org, so
  trapping an authenticated user is a defect, not an edge case.
- **Email-match is a hard wall** (anti-takeover, pairs with the unverified-IdP rule
  in parent spec §3): mismatch renders switch-account copy, never an auto-link.

### 1.4 First-run screen patterns (what good looks like)

- **≤3 fields before value, all prefilled** (ClickUp one-field, Userpilot 2026
  guidance). Ours: two fields, both prefilled from verified sources (OIDC claims +
  local-part fallback the server already guarantees — §2 contract).
- **Advance-anyway on write failure**: the screen is Orient, not a gate. Optional
  writes that strand users on error are the worst onboarding defect class — defaults
  are human-readable by construction (personal org name non-null), rename lives in
  settings. Telemetry-log and continue.
- **Freshness is server-derived, never a client flag** (parent spec §4). Our rule
  (§3) uses two server rows the client already reads — no new endpoint, no drift.

---

## 2. Verified Engine contracts (checked against `engine/src` 2026-09-16)

Every path below was read in source, not assumed. Frontend code MUST match these
shapes exactly; any drift is a build-blocking defect.

| # | Contract | Source |
|---|---|---|
| C1 | `GET /console/org/contexts` (L1, no org scope) → `{ contexts: [{ orgId, role, name }] }` | `org.controller.ts:161-164` |
| C2 | `GET /auth/me` (L1) → `{ account: { id, email, email_verified, display_name, mfa_level, status, last_login_at, created_at } }` | `account.controller.ts:80-97` |
| C3 | `PATCH /auth/me` `{ display_name: 1..256 }` → `{ ok: true }`, `@Idempotent` | `account.controller.ts:99-108` |
| C4 | `PATCH /console/org/:orgId/settings` `{ name: 1..256 }`, roles owner/admin, `@Idempotent`, audited from→to → `{ ok: true }` | `org.controller.ts:210-231` |
| C5 | `GET /console/onboarding` → `{ complete, completed_steps, steps: [{ key: create_project \| create_api_key \| start_trial \| first_usage, title, hint, route, done }] }`; `first_usage` = spend-events row (billing spend only) | `onboarding.service.ts:38-55` |
| C6 | `POST /console/org/invites/:inviteId/preview` `@Public`, body `{ token }` → `{ org_name, role, expires_at, invited_by, email_hint }` (masked `j***@domain`); **uniform 404 `invitation` for every non-usable state** (missing/revoked/expired/accepted/locked/bad-hash) — no oracle | `org.controller.ts:191-199`, `invites.service.ts:309-335,437-447` |
| C7 | `POST /console/org/invites/:inviteId/redeem` L1, body `{ token: 16..256 }`, `@Idempotent` + rate limit → `{ ok: true, orgId, role }` + audit `org.invite_accepted` + event `OrgInviteAccepted` | `org.controller.ts:167-177`, `invites.service.ts:237-300` |
| C8 | Redeem failure semantics (exact): bad id/hash → **401** `Invalid invitation` (+attempt); revoked/accepted → **409** `Invitation is no longer usable`; expired → **409** `Invitation expired`; attempts ≥ 5 → **409** `Invitation locked after too many attempts`; email mismatch → **403** `This invitation was sent to a different email address` (+attempt, invite stays usable); seat/member-cap refusal → error propagates, **invite stays usable by design** | `invites.service.ts:245-277` |
| C9 | Server display-name fallback = email local-part (upsert + claims), so UI fallback `claims.name ?? local-part` can never render undefined | `accounts.service.ts:50,119` |
| C10 | Personal org autocreated on `AccountCreated` for EVERY first login (email-code and social identical); `GET /console/home` self-heals a missing personal org at the login choke point | `org-access.service.ts:37-82`, `console-home.service.ts:72-90` |
| C11 | Home/contexts carry **no** `created_at`/`kind`/freshness — freshness MUST be derived from C1 + C2 (see F1 §3), never requested as a new field without a ledger amendment | `console-home.service.ts:23-48`, `org-access.service.ts` `listContexts` |
| C12 | Invite email link shape: `{ENGINE_BASE_URL}/platform/invites/:inviteId?token=` | `invites.service.ts:338-340` |

> ⚠️ FLAG-1 (verify before F2 build): C12 uses `ENGINE_BASE_URL` while
> `ENGINE_UI_BASE_URL` exists precisely for UI links ("auth email links point here,
> not at the API" — `env.ts:43`). If `ENGINE_BASE_URL` is the API origin in any
> environment, emailed invite links land on the wrong host. Resolution (env align
> OR link-base switch) must be recorded here before F2 ships.
>
> ✅ RESOLVED 2026-09-16 (link-base switch): `inviteUrl`
> (`invites.service.ts:338-346`) now prefers `ENGINE_UI_BASE_URL` with
> `ENGINE_BASE_URL` fallback. Dev `.env` confirmed the defect
> (`ENGINE_BASE_URL=:3001` API vs `ENGINE_UI_BASE_URL=:3000` console — emailed
> links previously pointed at the API, which serves no frontend). Edge-unified
> deployments (single public base, UI var empty) behave exactly as before —
> zero regression surface. Engine `tsc --noEmit` clean.

Frontend insertion points (verified present): post-login router
`pages/platform/AuthCallbackPage.tsx` (handleAuthCallback → navigate); route table
`router/routes.tsx`; session `lib/engine/auth.ts` (hydrate/refresh/silent); org
context `Context/OrgContext.tsx` (`neryva.active_org` + `X-Neryva-Org` + `adoptOrg`
for server-issued adoption); account hook `hooks/auth/useAccount.ts` (extended
with `created_at`/`last_login_at` — endpoint already returned them); run terminal
point `hooks/studio/useChat.ts:310` (`finalize`, case-insensitive success);
checklist `hooks/studio/useOnboarding.ts` (items + activation passthrough) +
`dashboard/DashboardView.tsx` (checklist card + first-value row).

Backend connection standard (all first-run server state lives in TanStack Query
custom hooks — `hooks/auth/useFirstRun.ts`; `engine()` is transport only, never
called from views for cached reads):

| UI / flow | Hook | Endpoint | Key (invalidator) |
|---|---|---|---|
| Welcome page contexts | `useOrgContexts` | `GET /console/org/contexts` | `['org','contexts']` (`invalidateOrgScope`) |
| Welcome account | `useAccount` (auth) | `GET /auth/me` | `['auth','me']` (`invalidateAuthScope`) |
| Welcome writes | `useSaveWelcomeNames` | `PATCH /auth/me` + `PATCH /console/org/:id/settings` (uuidv7 keys) | auth+org scopes on save |
| Post-login router | `fetchQuery` priming of the two keys above | same two GETs | warm cache — pages never refetch |
| Invite preview | `useInvitePreview` (`retry:false`) | `POST …/invites/:id/preview` (body token) | `['auth','invite-preview',id]` (dropped on logout) |
| Invite redeem | `useRedeemInvite` | `POST …/invites/:id/redeem` (body token, uuidv7 key) | explicit adopt + home refetch |
| Activation truth | `useOnboarding` | `GET /console/onboarding` → `activation` | `['studio','onboarding',org]` |

Documented deviations from `hooks/engine/mutations.ts` shape (intent preserved):
no toasts in these hooks (exact inline copy per ledger tables — a generic toast
would double-report); no `useOrgRequired` in redeem/welcome writes (redeem is
org-less by design; the welcome org id comes from freshness-checked contexts).

Section layout follows the repo convention — group dir → feature dir →
`Component.tsx` + `Component.styles.ts` + barrel `index.ts` (named exports, styles
never inline):
`sections/pages/platform/welcome/` (F1 screen),
`sections/pages/platform/invite/` (F2 page). Shared auth chrome stays imported
from `sections/pages/auth/` (`SignInSection.styles`, `LogoMark`); no forks.

Review fixes applied during build (self-review, 2026-09-16): preview transport
errors (offline/5xx/429) render retry instead of the invalid screen (an invalid
verdict on a live invite would be a lie); redeem 400 (DTO length guard on a
hand-crafted token) is terminal like 401; TanStack `validateSearch` routes
navigate with literal paths only.

---

## 3. F1 — First-run screen (new customer page)

**Goal:** a brand-new customer sees exactly ONE welcome screen after first login;
everyone else (has orgs, returning, invited) never sees it.

**Route:** `/platform/welcome` (console-internal, guarded by `requireEngineSession`;
NOT the OP callback — the callback stays dumb and routes here via the post-login
router).

**Gate rule (F1-7 — durable server state, no client flag, NO wall clock):**

```text
onboarding.needed = authenticated
  AND (no account_onboarding row OR welcome_completed_at IS NULL
       OR recorded consent_version ≠ current LEGAL__TERMS_VERSION)
  AND no usable pending-invite stash (invite path takes precedence — F2)
```

Rationale: "has this account seen the welcome screen and consented?" is a fact
about the account, not about the clock. The replaced heuristic (`contexts.length
=== 1` AND `created_at` within 30 min) conflated "account is new" with "account
was onboarded" and failed whenever the first login failed mid-flow — the screen
became unreachable forever. Absence of a row is the normal first-login state
(nothing is written until the account finishes or explicitly skips). Consent is
versioned: bumping `LEGAL__TERMS_VERSION` re-opens the gate exactly once per
account, with the previous consent preserved as evidence until re-accepted.
Enforcement lives in THREE places reading the same server truth: the post-login
router, the console route gate (`requireOnboardedSession`), and
`/platform/welcome` itself. Only a positive `needed === true` redirects — a
failed lookup advances (F1-6 discipline).

**Post-login router** (lives in the callback success path, before navigate):

```text
handleAuthCallback OK
  → if usable invite stash (F2: < 30 min, has inviteId+token) → /platform/invites/:id?token= (stash re-reads from URL; storage loss self-heals)
  → else fetch contexts + account in parallel
  → fresh-first-run → /platform/welcome (preserve deep-link return for after-continue)
  → else → stashed return target or /platform
```

**Screen spec:**

- Identity row: "Continue as {name} ({email})" — name from `GET /auth/me`
  (`display_name ?? local-part`, C9), avatar/initial; email read-only (IdP-verified).
- Field 1 — display name, prefilled `display_name ?? claims.name ?? local-part`.
- Field 2 — workspace name, prefilled `"<local-part>'s workspace"`.
- `[Continue →]` primary + secondary skip link. Both writes optional.
- Writes: `PATCH /auth/me {display_name}` (C3) + `PATCH /console/org/:orgId/settings
  {name}` (C4) via `Promise.allSettled`, each with its own `Idempotency-Key: uuidv7`.
  Partial/total failure → telemetry-log + **advance to dashboard anyway** (defaults
  human-readable; rename in settings). Never an error screen here.
- 422s render as field errors verbatim (only failure mode that blocks a field).
- Full keyboard + screen-reader support (labels, `role=alert` errors, focus order);
  max two fields; no company/role/slug/trial content (parent spec §1 rules).
- After continue/skip → deep-link return target or dashboard (personal org context).

**Tasks:**

- [ ] F1-1 Extend `EngineAccount` (`hooks/auth/useAccount.ts:13-20`) with
      `created_at: string` (+ `last_login_at` for future use) — endpoint already
      returns them (C2), no engine change.
- [x] F1-2 (SUPERSEDED by F1-7) ~~`FIRST_RUN_WINDOW` constant + `isFreshFirstRun`~~
      → replaced by `needsOnboarding(onboarding)` (`lib/engine/first-run.ts`) +
      `resolveOnboardingState` (engine `onboarding.service.ts`); the wall clock is gone.
- [ ] F1-3 Post-login router in callback path (stash check → parallel
      contexts+account → welcome vs return target).
- [ ] F1-4 `/platform/welcome` route + `WelcomePage`/`FirstRunSection` (auth chrome
      family — reuse `LoginSection` visual language, new file, no fork of `/auth`).
- [ ] F1-5 The two writes via `allSettled` + per-write idempotency keys +
      advance-anyway + 422 field errors.
- [x] F1-6 Abandon/resume (F1-7 form): no client persistence — the gate is
      `account.onboarding.needed`, so the screen REAPPEARS on the next app
      navigation until it is completed once (consent + continue, or consent +
      skip); after completion it never reappears. A failed lookup advances and
      never traps.
- [ ] F1-7 Copy + a11y pass (labels, alerts, focus, keyboard-only run).

**Edge cases (must hold):** OAuth email matches existing account → old account row →
dashboard, never screen (upsert, no duplicate — parent spec §3). Unverified IdP
email → subject-only fresh account → screen is still correct (rename works; linking
rules untouched). User abandons screen → dashboard with defaults. Returning user,
second login → window expired → dashboard. Personal org later becomes company org
via rename + invites (no migration — help copy states this).

---

## 4. F2 — Invite acceptance flow (new correct page)

**Goal:** an invitee goes email-link → (preview → sign-in if needed) → lands in the
inviter's org with context, or gets an honest, escapable error. No strandings.

**Route (frontend MUST own):** `/platform/invites/:inviteId?token=` — this is the
exact shape Engine emails (C12). Token stays in the URL only until read, then lives
in the stash + request bodies, never in query again.

**Page states:**

1. `loading` — read `inviteId`+`token` from URL → stash `neryva.pending_invite`
   `{inviteId, token, savedAt}` in **localStorage** (newest wins; NOT sessionStorage —
   mobile OAuth app-switches and new-tab sign-ins lose tab storage) → `POST preview`
   (C6, token in body).
2. `preview-ok` (anonymous OR authenticated) — "You've been invited to {org_name}
   as {role}" + "Invited by {invited_by}" + "For mailbox {email_hint}" + expires.
   Anonymous CTA: "Sign in to accept" (starts OP flow; post-login router returns
   here — the page re-stashes from URL every load, so total storage loss
   self-heals via the email link). Authenticated CTA: "Accept invitation".
3. `accepting` → `POST redeem` (C7, token in body) → set active org =
   `redeem.orgId` via the existing OrgContext mechanism (`neryva.active_org` +
   `X-Neryva-Org`) **BEFORE routing** (hard reloads keep team context; NEVER
   default to `contexts[0]` — index 0 is the fresh personal org) → clear stash →
   land directly in inviter org → context banner "`{invited_by}` invited you to
   `{org_name}` as `{role}`" → role-scoped dashboard (existing guards).
   No first-run screen, no workspace-name step — ever.
4. `invalid` (preview 404 — uniform, no reason disclosed pre-auth) — "This
   invitation link is invalid or expired." + "Continue to my workspace" exit
   (personal org via F1 freshness logic → dashboard). Never trap an authenticated
   user here.
5. Authenticated redeem failures (exact copy per C8):
   - 403 different-email → "This invitation was sent to {email_hint}. Sign in with
     that address to accept." + account-switch action (sign out → back here;
     stash retained).
   - 409 expired/revoked/locked/used → invalid screen + workspace exit (stash cleared —
     terminal).
   - Seat/member-cap refusal → "This workspace is full. Ask an owner to add seats,
     then retry — your invitation is still valid." + retry (stash retained; redeem
     is `@Idempotent`, accidental re-fire safe).
   - 401 invalid → treat as terminal-invalid (attempts burn server-side; do not
     auto-retry in a loop — one retry max, then invalid screen).

**Stash lifecycle:** clear on success + terminal (expired/revoked/used/invalid);
RETAIN on retryable (seat-full, email-mismatch). Ignore stash older than 30 min at
router time. Re-fire safe by construction (C7 idempotency).

**Tasks:**

- [ ] F2-0 Resolve FLAG-1 (invite link base) and record the resolution here.
- [ ] F2-1 `/platform/invites/:inviteId` route + `InvitePage` (public route shell —
      must render meaningfully while anonymous; guarded shells must NOT wrap it).
- [ ] F2-2 Stash helpers (`neryva.pending_invite`: write newest-wins, read+age-gate
      30 min, clear) — single module, no inline copies.
- [ ] F2-3 Preview integration (C6) incl. loading/invalid states + masked-hint copy.
- [ ] F2-4 Sign-in handoff: return target = invite URL; post-login router
      precedence (F1 §router) + URL re-stash self-heal.
- [ ] F2-5 Redeem integration (C7) + exact failure copy table above + banner +
      active-org-before-routing + role-scoped landing.
- [ ] F2-6 Stash lifecycle (clear vs retain matrix) + no-loop guard on 401.
- [ ] F2-7 Copy + a11y pass.

**Edge cases (must hold):** invitee is brand-new → personal org autocreates too
(expected, stays in picker — parent spec §2). Already-member redeems → conflict
copy, lands in org. Resend rotates token → old emailed link becomes invalid screen
(correct — resend kills prior hash server-side). Scanner prefetch hits preview →
no side effects by construction (C6). Expired while reading → redeem 409 path.

---

## 5. F3 — Activation instrumentation

**Definition (locked, parent spec §6):** activation = **first successful assistant run
in the org, production OR test-run**. Rationale: equals "experienced core value";
measurable; matches template→install→test-run as the shortest value path.

**Why not `first_usage`:** C5's `first_usage` = billing spend-events row; test/eval
runs skip billing entirely — the TTFV-critical path would never register. Rejected
as proxy (recorded, not revisit-able without amendment).

**Metrics (from day one):**

- `activation_rate_7d` = activated orgs ÷ new signup orgs (same weekly cohort) × 100.
- `ttfv_median` = median(signup → first activation), minutes. Median, never mean.
- In-session flag + 7-day window both tracked; definition frozen in this ledger
  (name changes require amendment — "the name is the contract").
- Segment by acquisition source (direct signup vs invite) and sign-in method when
  available.

**Sources:**

- In-session: `useChatSession.finalize` (`hooks/studio/useChat.ts:310-328`) on
  terminal success (case-insensitive `completed`/`succeeded` — the parser
  preserves server case `COMPLETED`; `markActivation(orgId, runId)` once per org
  per tab + `['studio','onboarding']` invalidation; `lib/engine/activation.ts`).
- 7-day truth: **SP-1 RESOLVED 2026-09-16 (no new state):** `runs`
  (`conversations/schema.ts:92-137`) carries `organizationId` + `state` +
  `runKind` (`standard` billable / `test` draft / `eval` harness) + `finishedAt`.
  Activation query = `MIN(finishedAt)` where org + `state='COMPLETED'` +
  `runKind IN (standard, test)` (eval excluded — harness, not user value;
  terminal states per `state-machine.ts:22`). Implemented in
  `ConsoleOnboardingService.state()` (`onboarding.service.ts:49-83`) as additive
  `activation: { activated, first_activation_at }` — existing `steps` shape
  untouched; console parser tolerates old engines (absent → not-yet).

**Tasks (all complete except F3-4 live observation):**

- [x] SP-1 Run-projection spike → `runs` table, `MIN(finishedAt)` over
      `COMPLETED × (standard,test)`; implemented, no new state.
- [x] F3-1 In-session hook at `finalize` (success-only incl. server-case
      `COMPLETED`, once per org per tab, onboarding invalidation).
- [x] F3-2 7-day cohort truth (`activation` block in onboarding state; cohort
      aggregation rollup = follow-up analytics task, §7.6).
- [x] F3-3 Activation row in the dashboard Get-set-up card (server truth, date
      when known; tolerated absent on old engines).
- [ ] F3-4 Smoke-test record — procedure §7.5, needs running engine + real run.

---

## 6. Status board

| ID | Item | State |
|---|---|---|
| F1-1 | `EngineAccount` + `created_at`/`last_login_at` (`hooks/auth/useAccount.ts`) | done |
| F1-2 | `FIRST_RUN_WINDOW` (30 min) + `isFreshFirstRun` + `emailLocalPart` (`lib/engine/first-run.ts`, pure) | done |
| F1-3 | Post-login router (`lib/engine/post-login.ts` + callback wiring; invite → welcome → return; failure falls through) | done |
| F1-4 | `/platform/welcome` route + `WelcomePage` + `WelcomeSection` (auth chrome, identity row, 2 prefilled fields, skip) | done |
| F1-5 | Dual writes, allSettled, per-write uuidv7 keys, 422-verbatim-hold, transport toast + advance-anyway, session refresh | done |
| F1-6 | Abandon/resume (server re-derivation; non-fresh bounces out; error advances) | done |
| F1-7 | Copy + a11y pass (labels, alerts, focus, keyboard submit) | done |
| F2-0 | FLAG-1 invite-link base resolution (switch, above) | done |
| F2-1 | `/platform/invites/:inviteId` top-level public route + `InvitePage` | done |
| F2-2 | `neryva.pending_invite` stash module (`lib/engine/invite-stash.ts`: newest-wins, 30-min age gate, shape-guarded) | done |
| F2-3 | Preview integration (C6; `retry:false`; uniform invalid; masked-hint copy) | done |
| F2-4 | Sign-in handoff (stash + return URL; URL re-stash self-heal; router precedence) | done |
| F2-5 | Redeem + exact failure copy + banner (`InviteBanner` on console home) + active-org-before-routing (`adoptOrg`) | done |
| F2-6 | Stash lifecycle (clear on success/terminal; retain on seat-full/mismatch/transient; single-flight accept, no 401 loop) | done |
| F2-7 | Copy + a11y pass | done |
| SP-1 | Run-projection source spike (resolved above, no new state) | done |
| F3-1 | In-session activation hook (`finalize` + `activation.ts` marks + onboarding invalidation) | done |
| F3-2 | 7-day cohort truth (`activation` block in onboarding state) | done (server truth; cohort aggregation = future rollup, see §7) |
| F3-3 | Funnel surface (activation row in dashboard Get-set-up card) | done |
| F3-4 | Smoke-test record | pending — procedure in §7, needs running engine + real run |

**Done definition per item:** implemented + `tsc -b` clean + `eslint` clean on touched
files + live probe against Engine (providers/authorize matrix for auth-adjacent;
endpoint round-trips for F1/F2; event landing for F3-4) + this ledger flipped to
`done` with the verification noted. Static legs are green in both repos
(console `tsc -b` clean, `eslint` 0 errors on all touched files; engine
`tsc --noEmit` clean). Live legs are recorded in §7 — engine :3001 was down at
build time.

Full patch review 2026-09-16 (worktree-vs-HEAD diff, every hunk read): engine
hunks exact with no collateral; console session layer, hook alignment, routes,
and all three features verified against this ledger. Findings fixed in review:
`setActive` localStorage write hardened for private mode (matching
`adoptOrg`/clear paths); invite preview transport errors render retry instead of
the invalid screen; redeem 400 treated terminal like 401; sections moved to the
repo `feature/Component.tsx + Component.styles.ts + index.ts` convention (no
inline styles). One false alarm chased to ground: non-ASCII copy was verified
intact at codepoint level — the console glyphs were a shell rendering artifact,
not file damage.

## 7. Live verification (post-restart runbook)

Engine :3001 refused connections at build time (curl exit 7, TCP false), so the
endpoint legs below are UNPROVEN, not skipped. After `node --env-file=.env
dist/main.js` in `engine/` (note: dist predates the inviteUrl/activation edits —
rebuild first. 2026-09-16 pm: dist rebuilt WITH the social two-leg finish;
the website also needs a restart — vite.config gained `/auth/auth → :3001`
and `changeOrigin:false` on `/engine` + `/login`):

0. F1-7 onboarding gate (VERIFIED LIVE 2026-09-17; migration `0061` applied,
   engine :3001 rebuilt + running): `dev_scripts/qa-onboarding-gate.ps1` —
   ALL PASS. A real email-code OAuth round-trip proves: `GET /auth/me` carries
   `account.onboarding` with `needed=true` + a `terms_version` on a brand-new
   account; the open gate is stable across reads (no wall clock); completion
   WITHOUT consent → 400; a stale `terms_version` → 409; consent (+ skip) →
   201 with `needed=false`, `welcome_skipped=true`, `consent_version` recorded;
   `GET /auth/me` agrees (durable server state); a replay keeps the FIRST
   completion stamp; org contexts = 1. Audit rows
   `account.onboarding_completed` are written per completion. Suites: engine
   27 files/175 tests + console 13 files/83 tests green; `tsc` + `eslint`
   clean in both repos. The pre-existing first user (rushaashish12@gmail.com)
   is deliberately left un-onboarded (`needed=true`) as the acceptance
   subject: its next login MUST land on `/platform/welcome` — the exact case
   the freshness window broke (first console grant landed 75.8 min after
   account creation, so `contexts.length === 1` held but the window had
   closed and the screen was never shown).
   DIAGNOSTIC NOTE (cost half a day here — do not repeat it): `org_memberships`
   and every tenant-furniture table run under ENABLE + **FORCE** ROW LEVEL
   SECURITY. A raw psql/node read without `app.engine_bypass='on'` returns
   ZERO rows even when rows exist. The "personal org missing / 0 memberships"
   reading was exactly this artifact — the org existed (audited `org.created`
   21 ms after `account.created`). Always read through engine endpoints, or
   set the bypass GUC inside a transaction (`zz-*.mjs` probes show the shape).
0b. Social pre-flight (new 2026-09-16 pm, blocks every leg below): restart engine
   (rebuilt dist) AND website (new proxy table). Authorize with
   `&connection=google` → 303 `/login/:uid/social/google` with
   `Set-Cookie: _interaction … Path=/login/:uid/social/google` (proves the
   cookie-scoping diagnosis); `GET /login/:uid/social/google/complete` with no
   cookies → branded 410 (proves the finish route is live); `returnTo` host in
   the interaction row must be `:3000`, never `:3001` (proves Host
   preservation). Then the real Google click-through should reach the app —
   the "Sign-in session expired" page is fixed by the finish leg + resume
   proxy (see `docs/frontend/sso.md §1.1`).
1. `GET :3001/login/providers` → `[{key:google}]`; Vite `:3000/engine/login/providers`
   → same (F1/F2 page data path).
2. Fresh Google signup → lands `/platform/welcome` with prefilled name/workspace
   (F1-3/F1-4); Continue → PATCHes fire → dashboard; reload → dashboard, never
   welcome (F1-6); second account same browser → dashboard (freshness window).
3. Skip → dashboard with defaults; rename later in settings (F1-5 advance-anyway:
   stop engine mid-save → toast + dashboard, no trap).
4. Invite: create invite (owner) → emailed link now points at `:3000` (F2-0);
   anonymous open → preview card (F2-3); sign in → lands back with stash (F2-4);
   accept → inviter org + banner (F2-5); wrong mailbox → 403 copy; resend →
   old link invalid screen (rotation); expired → invalid + workspace exit.
5. Activation: template install → test-run to COMPLETED → dashboard card flips to
   "First value achieved" after onboarding refetch (F3-1/F3-3); `GET
   /console/onboarding` shows `activation.first_activation_at` (F3-2).
6. F3-4 closes when (5) is observed end-to-end; then define the cohort rollup
   (7-day rate + TTFV median) as the follow-up analytics task.
