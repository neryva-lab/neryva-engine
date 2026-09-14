# First-Run Flow — Account → Organization → Dashboard

> Status: proposed plan (not yet implemented).
> Owner: Frontend team + Engine platform team.
> Scope: **the first 60 seconds** — what a brand-new customer sees between OAuth callback and a working Agent Studio dashboard. Decides the open question: auto-org vs setup form.
> Non-goals: changing Engine creation semantics, billing/entitlement math, or the MCP contract. All Engine behavior cited below already exists; this plan only sequences UI around it.
> Research basis: B2B signup/onboarding patterns (Slack workspace-as-signup, Notion minimal-signup + inferred segmentation, Vercel personal-first + collaboration-triggered team upgrade, Figma defer-team, ClickUp skippable steps, 3–6 step ceiling, "every question must change the product").
> Verification: Engine citations re-checked against `engine/src` on 2026-09-15. Paths repo-root-relative.

---

## 0. Decision (read first)

**Neither pure-auto nor mandatory company form. Do both, in this order:**

1. **Data layer stays automatic** — Engine already creates a `personal` org + owner membership on `AccountCreated` (`org-access.service.ts:37-82`), identically for email-code and social first logins. Do not fight this; do not create a second org in first run.
2. **UI shows ONE lightweight first-run screen** — "Continue as {name} ({email})" (prefilled from OIDC claims, name editable) + **workspace name** (prefills `"<local-part>'s workspace"`, writes `tenants.name` via the existing PATCH). Two fields, both prefilled, both skippable → dashboard.
3. **Everything else becomes the live onboarding checklist** (`GET /console/onboarding`, server-computed) — invite teammates, start trial, create project, run first assistant. Checklist, not wizard: completable out of order, resumable free (server state), never blocking.

Rationale: the research converges — Notion proves minimal signup + inferred segmentation scales; Vercel proves personal-first with team-upgrade at collaboration events converts without paywall feeling; SaaS Boat/StarterPick cap the flow at 3–6 steps where every step delivers visible product progress. A mandatory company-details gate would *add* friction to buy information the product cannot act on (no Engine field consumes company size, role, or industry).

### Why NOT "auto-create a team org in first run"

- The personal org already exists by the time the callback lands. Creating a team org too leaves **two orgs** (personal `pers-xxx` + team) → picker confusion, split trial/entitlement lifecycles, billing ambiguity, and an orphan personal org the user never asked for.
- There is **no personal→team conversion**: `org_settings.kind` is set at creation (`team` eager in `insertOrgWithOwner`, personal lazy-default — `org-access.service.ts:169-172`, `schema.ts:105-106`) and no endpoint changes it. Renaming the personal org achieves "company workspace" with one tenant and one entitlement lifecycle.
- Proper slugs belong to explicit team creation later (`POST /console/org` with user-chosen immutable slug + reserved-name + ownership-cap rules — `org-access.service.ts:93-135`). The personal `pers-xxx` slug has no product effect today (console routes use IDs/keys), so asking for a slug in first run violates the every-question-must-change-the-product rule.

---

## 1. Flow A — direct signup (no invite)

```text
OAuth (any enabled provider) → Engine OP → /platform/auth/callback?code&state
  → token grant → GET /console/org/contexts
      │
      ├─ exactly 1 membership AND org is fresh* → FIRST-RUN SCREEN (one screen)
      │     • identity row: avatar/name/email from claims (read-only email —
      │       it is IdP-verified; no verification step exists or is needed)
      │     • display name [prefilled: claims.name ?? local-part] → PATCH /auth/me
      │     • workspace name [prefilled: "<local>'s workspace"] → PATCH /console/org/:orgId/settings {name}
      │     • [Continue →] (skip link secondary — both writes are optional;
      │       abandoned form = default names, rename later in settings)
      │   → dashboard (org context = the personal org)
      │   → onboarding checklist card (Engine state: project? key? trial? first run?)
      │
      └─ 0 or 2+ memberships → ORG PICKER (no first-run screen; see §3 edge cases)
```

*Fresh = `org_settings` row absent (personal lazy) or `created_at` within the session. Never gate on a client flag — server state only, so any abandonment resumes cleanly with defaults.

First-run screen rules: max two fields, both prefilled; no company size / role / use-case survey (nothing consumes them); no slug field; no trial pitch here (trial lives in the checklist where `limits` state makes it contextual); full keyboard + screen-reader support; error copy from server 422s verbatim.

First-run write discipline (the onboarding seam is the worst place to strand a user):

- Display-name fallback is `claims.name ?? email local-part` — Engine guarantees the same fallback server-side (`claimsFor`, social resolve, and `upsertByEmail` all default to the local part), so this only guards exotic IdPs (Apple relay, locked-down GitHub). The UI must never render an undefined name.
- Fire `PATCH /auth/me {display_name}` (1..256, `account.controller.ts:99-107`) and `PATCH /console/org/:orgId/settings {name}` (1..256, audited from→to) via `Promise.allSettled`, each with its own `Idempotency-Key` (both writes are set-to-value, hence retry-safe; settings additionally carries the server `@Idempotent` decorator).
- On partial/total failure: log to telemetry and **advance to the dashboard anyway** — the step is optional, defaults are human-readable (`"<local>'s org"`, non-null by construction in `createPersonalOrg`), and rename stays available in settings. Never an error screen here.

### Activation event (define once, instrument everywhere)

Proposed: **first successful assistant run in the org** (production or test-run — both write the same run projection). It is measurable server-side, equals "user experienced core value," and matches the Engine checklist's `first usage` signal. Track signup→activation within-session and within-7-days from day one.

---

## 2. Flow B — invited user (different path, less UI)

```text
Invite email link (/platform/invites/:inviteId?token= — exact shape Engine
generates in invites.service.ts:284-286; the frontend MUST own this route)
  → stash {inviteId, token} in sessionStorage BEFORE any redirect
  → if anonymous: OAuth first (same OP flow; new account auto-creates AND
    gets its own personal org via the unconditional AccountCreated listener —
    this is expected, not a bug; the personal org stays in the picker's list)
  → on callback with stashed invite: POST /console/org/invites/:inviteId/redeem
  → set active org = redeem.orgId (response returns {orgId, role} —
    invites.service.ts:280). NEVER default to contexts[0]: index 0 is the
    fresh personal org, not the team org.
  → persist via the existing OrgContext mechanism (`neryva.active_org` in
    localStorage, injected as X-Neryva-Org — OrgContext.tsx:44,84-85) BEFORE
    routing, so hard reloads keep the team org context.
  → stash lifecycle: clear the stashed invite on success and on TERMINAL
    failures (expired/revoked/used). RETAIN it on retryable outcomes
    (seat_limit_reached — the invite stays valid and the user retries;
    email-mismatch — the user may switch accounts in the same tab).
    Accidental re-fire is additionally safe: redeem carries `@Idempotent`
    + `org-invite-redeem` rate limiting (org.controller.ts:161-162).
  → land DIRECTLY in the inviter's org — NO first-run screen, NO workspace-name step
  → context banner: "<Admin> invited you to <Workspace> as <role>"
  → role-scoped dashboard (member sees collaboration surfaces, not setup/billing —
    enforced by existing role guards + capabilities.ts)
```

Redeem failure copy (exact Engine semantics — render these, not generic errors):

| Engine outcome | UI copy |
|---|---|
| 403 `sent to a different email address` (`invites.service.ts:243-246` — redemption requires the session email to match the invite) | "This invitation was sent to {invite.email}. Sign in with that address to accept." + account-switch action |
| 409 expired / revoked / locked / already-used (`:232-240,266-268`) | Uniform invalid-invite screen WITH a "Continue to my workspace" exit — a brand-new user already owns a fresh personal org (unconditional autocreation), so never trap an authenticated user on an error page. The button sets active org to their personal org (Flow A freshness logic) and routes to dashboard. |
| 409 seat-full / member-cap (`seatLimitReached`, `organization is at its member cap` — `memberships.service.ts:277-279,314`; invite stays usable by design, `invites.service.ts:248-252`) | "This workspace is full. Ask an owner to add seats, then retry — your invitation is still valid." + retry button (do NOT burn the token client-side). Member cap is abuse posture, not billing — same retryable pattern. Re-activating a removed member consumes no additional seat. |

Invited users already know why they are here (research: show inviter + workspace + role context, minimize setup, guide to one collaborative first action). Expired/revoked invites render the uniform invalid-invite state, never an org-creation detour.

---

## 3. Edge cases (all must be handled)

| Case | Behavior |
|---|---|
| OAuth email matches an existing account | Normal login, not first run (`upsertByEmail` / subject-first resolve — no duplicate account possible) |
| Unverified IdP email | Never links to an existing account (anti-takeover — `social-account.service.ts:67-73`); fresh subject-only account instead. UI does nothing special. |
| User abandons first-run screen | Dashboard with default names; settings + checklist prompt rename later. No stuck state (nothing client-persisted). |
| Invite teammates on a `personal` org | Fully allowed — no Engine path gates invites/members on `kind` (invite guards are member/pending/ceiling only; seat wall fires solely on seat-bearing entitlements, and orgs without one have no cap). No team-org detour needed; trial/billing stay on the one org. |
| User already has orgs (returning, second login) | Org picker; first-run screen never reappears (freshness is server-derived). |
| Ownership cap reached on later team creation | 409 `ownership_cap_reached` → upsell/block copy (cap `ORGS__MAX_OWNED_PER_ACCOUNT`). |
| Slug taken/reserved on team creation | 409 `slug_taken` (suggest alternatives) / `slug_reserved`. First run never hits this (no slug field). |
| Personal org later needs to BE the company org | It already is: rename + invite teammates + start trial. No migration, no second org. Document this in help copy. |
| Enterprise SSO/SCIM/domain-claim | Deferred until deal-size justifies (research consensus). Engine already delegates SAML to the IdP with callback + rotation tests; hooks exist. |

---

## 4. What we explicitly do NOT build

- Mandatory company-profile gate (size, industry, phone, address) — no consumer, pure drop-off.
- Separate "signup" vs "onboarding" funnels — signup IS the first onboarding step (research: separating them creates the gap users drop through).
- Client-side first-run flags — freshness and checklist are server-computed; the client holds no "hasOnboarded" state to drift.
- Team-org auto-creation, personal→team conversion endpoint, or slug editing in first run.
- Time-based drip emails — behavior-triggered nudges only (checklist state transitions), one action + one deep link each.

---

## 5. Acceptance criteria

- [ ] OAuth → callback → (first-run screen iff fresh single org) → dashboard in ≤2 screens, every field prefilled, every step skippable.
- [ ] Display-name + workspace-name writes hit `PATCH /auth/me` and `PATCH /console/org/:orgId/settings` respectively; 422s render as field errors.
- [ ] Invited users land in the inviter org with context banner, never see the workspace-name step.
- [ ] Abandoned first run → usable dashboard with defaults; rename available in settings.
- [ ] Checklist reflects Engine `GET /console/onboarding` truthfully (no client-side completion flags).
- [ ] Signup→first-successful-run instrumented (in-session + 7-day).

---

## 6. Locked decisions (2026-09-15)

- **Activation event:** first successful assistant run in the org (production or test-run). Instrumented in-session + 7-day from day one.
- **Trial placement: value-first.** Engine permits runs with no entitlement row — the quota wall passes open absent a plan row (`conversations.service.ts:446-460`; only `deployment`/`studio-furniture` routes are entitlement-gated) and test/eval runs skip quota + billing entirely. Trial is prompted contextually (limits view, usage approach, collaborator invite), never as a gate before first value.
- **Default project: user-created.** Runs work unscoped; the checklist prompts project creation. No auto-created "Getting started" project.
- **Template-first activation:** the shortest path to first value is template gallery → install → test-run (zero quota/billing risk); blank-assistant editor stays secondary.

---

## References

- `engine/src/modules/organizations/org-access.service.ts:37-135,144-174` — autocreation + team creation + shared atomic transaction
- `engine/src/modules/identity/accounts.service.ts:32-83` — upsert-on-login, first-login verification
- `engine/src/modules/identity/social/social-account.service.ts:46-106` — subject-first / verified-link / create
- `engine/src/modules/organizations/org-settings.service.ts:101-130` — name PATCH via tenants seam (audited from→to)
- `engine/src/modules/console/console-platform.controller.ts:75-80` — live onboarding checklist
- `engine/src/modules/organizations/org.controller.ts:143-160` — create-team-org + invite-redeem routes
- Research: SaaS Boat signup-flow benchmarks (3–6 steps, progressive disclosure); Notion minimal-signup/inferred-segmentation; Vercel personal-first + collaboration-triggered upgrade; StarterPick B2B wizard (org-first, checklist-over-wizard, activation-event discipline); Skene stage model (welcome 0–5 min → first value 5–30 min).
