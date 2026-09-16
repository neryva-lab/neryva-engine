# Team-Loop Ledger — Invite → Accept → First Collaborative Action

> Status: IMPLEMENTED 2026-09-17 (end-to-end team-loop; Engine E0 + Frontend F1/F2 + T5-4 landed, review-hardening pass landed; verification §11 legs 0-2, 12-13 proven static — live invite round-trip pending a running stack).
> Build evidence 2026-09-17: engine `tsc --noEmit` clean, `eslint` 0 errors (1 pre-existing unused-import warning in `org-members.controller.ts`), `vitest` 27 files / 175 tests PASS, `npm run build` clean (dist rebuilt WITH detail route + resend idempotency + owner-remove tighten + self-remove-via-remove guard); console `tsc -b` clean, `eslint` 0 errors on all touched files, `vitest` FULL 13 files / 83 tests PASS (first-run/session-gate/auth included); grep gates: `accept_url` only in manual returns + email vars (never in audit/list), `referrer no-referrer` in `InvitePage.tsx` + `index.html`, `delivery` plumbed in `mutations.ts` (`useInviteMember` + `useResendInvite` both `idempotent:true`; invite-create `silentError:true` so the exact inline copy never double-reports).
> Review-hardening pass (manual, no trust in tests): `GET :orgId/invites/:inviteId` detail route-order safe (GET-vs-POST, no wildcard clash); self-exit forced through `POST members/leave` (`remove` on self → `409 use the leave endpoint`, preserving `org.member_left/self:true` evidence); `RoleSelect` drops the dead `owner` option (promotion always 409s on the exactly-one-owner index — transfer lives in Danger zone); `useInvitePreview` key carries the token (rotated links never serve the prior token's cached verdict); redeem `409 idempotency_in_flight` treated transient (stash retained, retry) instead of terminal; Teams groups readable by all roles + service accounts by all-but-reader (mutating buttons stay owner/admin-gated), matching the server `Roles` on both list endpoints.
> Review pass 2 (legacy sweep — frontend must robustly capture the engine): `useDeleteServiceAccount` consolidated from the gap-module `hooks/studio/useStudioTeams` into `hooks/engine/mutations` WITH step-up retry (the engine demands a fresh proof on `DELETE service-accounts/:id`; the legacy hook could not retry and stranded the click on `step_up_required`) — studio file kept as deprecated re-export, call-site fixed to `{id}` object form with no double toast; frontend `MemberRow`/`InviteRow`/summary-seats types aligned to the engine (`invitedBy/suspendedAt/suspendedBy`, `updatedAt/acceptedAt/revokedAt/attempts`, seats `plan` + `maxMembers`; suspended pill carries since-date provenance); redeem capacity routing hoisted ABOVE the status branches (the purchased seat wall is **402** `seat_limit_reached`, not 409 — it previously fell into the transport-failed copy instead of the workspace-full copy; member cap stays 409); invite-create `silentError` so exact inline copy never double-reports; `@neryva_data` + legacy axios confirmed OUT of team-loop surfaces (deployment/marketing static only — M0/M1.1 tracks, untouched).
> Owner: Frontend team + Engine platform team.
> Parent spec: `team-loop.md` (spec DONE + Engine work-list IMPLEMENTED 2026-09-15, 172 lines, decisions locked there).
> Companion: `first-run-onboarding.md` (Flow A direct signup + Flow B invited path), `first-run-ledger.md` (F1/F2/F3 build record), `ledger.md` (M1.6/M1.8 exit gates), `README.md` (locked decisions), `frontend_implementation_plan.md` (M0→M6 order).
> Scope: the complete membership lifecycle in the console — invite creation, delivery (email + manual copy-link PRIMARY), accept (new + existing users), role model and admin powers, new-member dashboard, suspension/removal/leave/transfer, audit/notification evidence. Nothing else lands under this ledger.
> Non-goals: changing Engine membership semantics (all cited behavior already exists except §9 polish), SCIM/domain-claim/SSO-JIT/guest/time-boxed grants/per-resource ACLs/invite-delivery telemetry (deferred §10 until enterprise contract), billing/entitlement math, MCP contract.
>
> Gate rule: E0 → F1 → F2 → F3, in that order. Every checkbox flips only on merged, verified work — never on intent.
> Invariants (all features): browser never authoritative; Engine REST/JSON only; `engine()` sole transport; `Idempotency-Key: uuidv7` on mutations; `X-Neryva-Org` on org-scoped calls; no tokens in localStorage (the invite-token stash `neryva.pending_invite` is the one deliberate exception — spec §3 rationale stands: short-TTL 30 min, single-purpose, email-bound, newest-wins, XSS already owns the session, CSP is the control); no secret material rendered (fingerprints only, shown-once secrets never re-fetched); hidden button ≠ security boundary (Engine `OrgRolesGuard`/`StepUpGuard` authoritative).
> Paths below are repo-root-relative (`neryva_studio/`): Engine files as `engine/src/...`, website as `console/neryva-website/src/...`.

---

## 1. Research basis (why each feature is shaped this way)

### 1.1 Stateful-pending-grant invite pattern

Server-side grant + short-lived claim token + atomic accept binding session-email to invited-email. The token is possession-only (proves nothing until the session email matches at redeem — the anti-pattern "click-to-provision" is structurally avoided). Resend rotates (old link dies immediately); preview is side-effect-free; membership write precedes the single-use claim so seat-full does not burn the invite; claim is a conditional update so double-redeem is idempotent.

### 1.2 Least-privilege role ladder with singular transferable owner

`owner | admin | billing | developer | reader`. Ownership is singular per org as a **partial unique DB index** (`uq_one_active_owner_per_org`, `engine/drizzle/0044_org_owner_invariant.sql:41-43`) — upper bound at the database (never two active owners even under concurrent transfer); lower bound (≥1 owner) application-enforced (`assertAnotherOwnerRemains`) so purge (which deletes all memberships) is never DB-blocked. Ownership moves only via explicit step-up-gated transfer — never by invitation (`INVITABLE_ROLES` excludes `owner`).

### 1.3 Suspend-before-remove offboarding

Suspend keeps the row + history (cheap recovery, immediate lockout); remove is the clean exit (group memberships follow). Both audited with actor + email. Resources are org-owned so nothing strands on removal; leaver history stays attributable.

### 1.4 Single-org-context enforcement

`neryva.active_org` in `localStorage` + `X-Neryva-Org` header + `adoptOrg` for server-issued adoption. Never default by array index (`contexts[0]` is the fresh personal org, not the team org). `adoptOrg` bypasses the membership pre-check (server just added us) and reconciles via home refetch; until refetch lands the active org resolves `null`, never a wrong org.

### 1.5 URL-first manual delivery (locked decision `team-loop.md:31-50`)

Enterprise gateways quarantine external invite mail AFTER accepting SMTP (mailer shows delivered, inbox never fills). The industry fix is a copy-link path bypassing the mailer entirely while keeping per-email binding (NOT open reusable links: open links turn the URL into a bearer credential and need a separate revocation design — explicitly rejected). Email retained as default; manual is PRIMARY for operators.

---

## 2. Verified Engine contracts (checked against `engine/src` 2026-09-17)

Every path below was read in source, not assumed. Frontend code MUST match these shapes exactly; any drift is a build-blocking defect.

| # | Contract | Source |
|---|---|---|
| C1 | `POST /console/org/:orgId/invites` L1 `Roles('owner','admin')` `@Idempotent` rate `org-invite-create 20/0.05 principal` body `{email 3..320, role ∈ INVITABLE_ROLES, delivery?: 'email'\|'manual'}` → email path `{inviteId, email}` (no URL); manual path `{inviteId, email, accept_url, expires_at}` ONCE | `engine/src/modules/organizations/org-members.controller.ts:21-38,191-213`, `engine/src/modules/organizations/invites.service.ts:61-114` |
| C2 | Create guards in order: role invitable (`assertInvitableRole`, owner excluded) → `normalizeInviteDelivery` fail-closed → `normalizeEmail` trim+lowercase → not active member 409 → not suspended member 409 `member_suspended` + `reason` → no usable pending `(org,email)` 409 → ceiling `ORG_MAX_PENDING_INVITES=100` 409 | `engine/src/modules/organizations/invites.service.ts:62-101`, `engine/src/modules/organizations/memberships.service.ts:563-567`, `engine/src/modules/organizations/schema.ts:175`, `engine/src/common/config/env.ts:122` |
| C3 | Token: `randomBytes(32).base64url`, stored `sha256Hex` only, TTL `ORG_INVITE_TTL_DAYS=7`, redeem attempts cap 5, resend cap 5, extend clamp 1..30d | `engine/src/modules/organizations/invites.service.ts:35-36,169-170,201-215,347-349`, `engine/src/modules/organizations/org-members.controller.ts:46-51`, `engine/src/common/config/env.ts:120` |
| C4 | `inviteUrl` server-built `(ENGINE_UI_BASE_URL \|\| ENGINE_BASE_URL).replace(/\/$/,'') + /platform/invites/:id?token=`, never request `Host` | `engine/src/modules/organizations/invites.service.ts:337-345`, `engine/src/common/config/env.ts:41-43` |
| C5 | List `GET :orgId/invites` `Roles('owner','admin')` → `InviteView[]` `{id,email,role,status,invitedBy,createdAt,updatedAt,expiresAt,acceptedAt,revokedAt,resendCount,attempts}`, status computed per read (never stored), cap 500 | `engine/src/modules/organizations/org-members.controller.ts:215-219`, `engine/src/modules/organizations/invites.service.ts:116-119,404-421` |
| C6 | `POST :orgId/invites/:id/resend {delivery?}` `Roles('owner','admin')` rate `org-invite-resend 10/0.02 principal` → rotates token (old hash dies, attempts reset, TTL restart), rotation guard `where tokenHash=readHash` (concurrent redeem/resend loses visibly), cap 5 → manual returns `{expires_at, accept_url}` once, email re-sends | `engine/src/modules/organizations/org-members.controller.ts:235-249`, `engine/src/modules/organizations/invites.service.ts:148-199` |
| C7 | `POST :orgId/invites/:id/extend {days 1..30}` `Roles('owner','admin')` → expiry push, token unchanged → `{expires_at}` | `engine/src/modules/organizations/org-members.controller.ts:251-264`, `engine/src/modules/organizations/invites.service.ts:201-230` |
| C8 | `POST :orgId/invites/:id/revoke` `Roles('owner','admin')` → one write, link dies immediately | `engine/src/modules/organizations/org-members.controller.ts:221-233`, `engine/src/modules/organizations/invites.service.ts:121-146` |
| C9 | `POST /console/org/invites/:inviteId/preview` `@Public` rate `org-invite-preview 20/0.05 ip` body `{token 16..256}` → `{org_name, role, expires_at, invited_by (displayName, never email), email_hint (j***@domain)}`; **uniform 404 `invitation` for every non-usable state** (missing/bad-hash/revoked/accepted/expired/locked) — no oracle, no attempt registration, no audit, token never logged | `engine/src/modules/organizations/org.controller.ts:179-199`, `engine/src/modules/organizations/invites.service.ts:302-335,437-452`, `engine/src/common/observability/logger.ts:19-59` (`*.token` redacted, `req.url` carries query but body absent) |
| C10 | `POST /console/org/invites/:inviteId/redeem` L1 `@Idempotent` rate `org-invite-redeem 10/0.1 principal` body `{token 16..256}` → `{ok:true, orgId, role}` + audit `org.invite_accepted` + event `OrgInviteAccepted` | `engine/src/modules/organizations/org.controller.ts:166-177`, `engine/src/modules/organizations/invites.service.ts:232-300` |
| C11 | Redeem failure semantics (exact): bad id/hash → **401** `Invalid invitation` (+attempt); revoked/accepted → **409** `Invitation is no longer usable`; expired → **409** `Invitation expired`; attempts ≥5 → **409** `Invitation locked after too many attempts`; email mismatch → **403** `This invitation was sent to a different email address` (+attempt, invite stays usable); seat/member-cap refusal → error propagates, **invite stays usable by design** | `engine/src/modules/organizations/invites.service.ts:244-280`, `engine/src/modules/organizations/memberships.service.ts:258-281,308-317` |
| C12 | Redeem ordering: `addMember` FIRST (seat/member caps checked HERE; refusal keeps invite usable) → single-use conditional claim (`where acceptedAt isNull revokedAt isNull`) → audit+event. `addMember` is upsert on `(account,org)` so concurrent double-redeem is idempotent | `engine/src/modules/organizations/invites.service.ts:267-287`, `engine/src/modules/organizations/memberships.service.ts:245-306` |
| C13 | Members: `GET :orgId/members` + `GET :orgId/members/:accountId` `Roles(owner,admin,billing,developer,reader)` → enriched `{accountId,email,displayName,role,status,mfaLevel,emailVerified,lastLoginAt,memberSince,lastActiveAt,invitedBy,suspendedAt,suspendedBy,groups}`; default `['active','suspended']`, `q` ilike email/display, limit 1..200 default 100 | `engine/src/modules/organizations/org-members.controller.ts:78-105`, `engine/src/modules/organizations/memberships.service.ts:83-164` |
| C14 | `PATCH :orgId/members/:accountId/role` `Roles('owner','admin')` body `{role}`; to `owner/admin` ⇒ actor must be `owner` + fresh MFA proof (imperative, target rides body); owner→non-owner requires another owner remains; promote-to-owner requires exactly one owner before transfer | `engine/src/modules/organizations/org-members.controller.ts:107-130`, `engine/src/modules/organizations/memberships.service.ts:326-367`, `engine/src/common/policy/step-up.guard.ts:25-31` |
| C15 | `POST :orgId/members/:accountId/suspend` + `/reactivate` `Roles('owner','admin')`; suspend refuses self (`you cannot suspend your own membership` 409) and owner targets (`owners cannot be suspended` 403); reactivate requires `suspended` | `engine/src/modules/organizations/org-members.controller.ts:132-158`, `engine/src/modules/organizations/memberships.service.ts:369-436` |
| C16 | `POST :orgId/members/:accountId/remove` `Roles('owner','admin')`; admin cannot remove `owner/admin` targets (`Only an owner may remove an owner or admin` 403 — self-removal bypasses the check and flows to service); owner removal requires another owner remains; group memberships follow; audited `org.member_removed` + `OrgMemberRemoved` + email | `engine/src/modules/organizations/org-members.controller.ts:160-179`, `engine/src/modules/organizations/memberships.service.ts:438-465` |
| C17 | `POST :orgId/members/leave` any role; last owner must transfer first (`the last owner cannot leave or be demoted — transfer ownership first` 409); groups cleaned; audited `org.member_left` | `engine/src/modules/organizations/org-members.controller.ts:181-187`, `engine/src/modules/organizations/memberships.service.ts:467-489` |
| C18 | Transfer `POST :orgId/transfer-ownership` `Roles('owner')` `@RequireStepUp @Idempotent` body `{target_account_id}` → ONE TX demote-then-promote (never two owners; index `uq_one_active_owner_per_org` backstop at every statement; crash rolls back; concurrent loses with 23505→`owner_already_present`); post-condition exactly-one-owner re-check; audited `org.ownership_transferred` + event + email to target | `engine/src/modules/organizations/org-lifecycle.controller.ts:35-39`, `engine/src/modules/organizations/org-lifecycle.service.ts:289-370`, `engine/drizzle/0044_org_owner_invariant.sql:41-43`, `engine/src/modules/organizations/memberships.service.ts:50-56` |
| C19 | Guard order per request: membership → role → ownership; `getRole` resolves from `active` rows only (suspend/remove = immediate session-independent lockout) + throttled `last_active_at` heartbeat (5 min); impersonated (`principal.imp`) read-only on all mutating member/invite routes | `engine/src/common/policy/org-roles.guard.ts:46-63`, `engine/src/modules/organizations/memberships.service.ts:507-532`, `engine/src/modules/organizations/org-members.controller.ts:125,139,153,167,209,245,261` |
| C20 | Seat wall at grant time inside TX: lock seat-bearing entitlement rows `FOR UPDATE` (serializes concurrent redemptions), skip when no seat-bearing entitlement (no cap), re-activating existing active member consumes no seat; hard member cap `ORG_MAX_MEMBERS=500` (abuse posture, not billing) | `engine/src/modules/organizations/memberships.service.ts:248-285,308-317`, `engine/src/common/config/env.ts:123,155` |
| C21 | Summary `GET :orgId/summary` → `{members{total,active,suspended}, pendingInvites (computed), serviceAccounts{total,active}, groups, maxMembers, seats[{product,plan,seats,activeMembers,utilization,state}]}` | `engine/src/modules/organizations/memberships.service.ts:182-234`, `engine/src/modules/organizations/org.controller.ts:233-240` |
| C22 | Idempotency fingerprint = `sha256(method\nurl\nJSON(body))`, scope `principal+key`, 24h TTL, in-flight 409, conflict on different body; failures not cached (safe retry) | `engine/src/common/http/idempotency.ts:50-99` |
| C23 | Audit covers `org.invite_created/resent/extended/revoked/accepted`, `org.member_added/role_changed/suspended/reactivated/removed/left`, `org.ownership_transferred` (+ `org.deletion_*`, `org.data_exported`, `org.purged`) — queryable per org, resource IDs present, details carry role/TTL/email/counts only, **never token/URL** | `engine/src/modules/organizations/invites.service.ts:356-364,185-193,220-228,136-144,289-297`, `engine/src/modules/organizations/memberships.service.ts:295-304,351-359,392-401,426-435,451-460,480-487`, `engine/src/modules/organizations/org-lifecycle.service.ts:117-126,342-350` |
| C24 | Notifications fan-out: new member `org.member_added` info; suspended warn; reactivated info; removed warn (never on self-leave); existing accounts `org.invite_created` info; owners/admins `org.invite_accepted` info; role change direct `org.role-changed` email + audit | `engine/src/modules/notifications/notifications.service.ts:131-206`, `engine/src/modules/organizations/memberships.service.ts:360-366,402-405,461-464,534-542` |
| C25 | Email normalization proven: `normalizeEmail` trim+lowercase at create + account lookup; `Alice@X.com` accepted by `alice@x.com` session | `engine/src/modules/identity/accounts.service.ts:125-131`, `engine/src/modules/organizations/invites.service.ts:64,261-264` |
| C26 | Groups + service accounts: `Roles('owner','admin')` for create/manage/rotate; service-account tokens shown once on create/rotate (hash-only storage), rotation voids previous | `engine/src/modules/organizations/org-groups.controller.ts`, `engine/src/modules/organizations/org-service-accounts.controller.ts` (same `Roles` pattern; console `TeamsView` consumes) |

> ⚠️ FLAG-E1 (Engine polish, additive, no migration — §9 E0.2/E0.3): spec text references `List / detail / extend NEVER return URL` (`team-loop.md:46`) but only list+extend routes exist — no `GET :orgId/invites/:inviteId` detail route (`engine/src/modules/organizations/org-members.controller.ts:215-219` only list). `toView` already exists (`engine/src/modules/organizations/invites.service.ts:404-421`). Add the detail read (hash-free) so the spec-grep gate passes literally.
>
> ⚠️ FLAG-E2 (spec-alignment, one line — §9 E0.4): spec prose `team-loop.md:19` says "Owners cannot be removed at all — only transferred out" while `removeMember` (`engine/src/modules/organizations/memberships.service.ts:438-442`) allows removal when another owner remains. Functionally unreachable today (transfer is demote+promote, never two owners; `changeRole` promote requires exactly one owner before transfer `engine/src/modules/organizations/memberships.service.ts:332-339`), but prose/code differ. Either tighten to `403 transfer ownership instead` or amend spec to the permissive invariant. Ledger tasks E0.4 cover the tighten path.

Frontend insertion points (verified present): post-login router `console/neryva-website/src/lib/engine/post-login.ts:64-112` (stash → invite-URL → welcome → fallback); callback wiring `console/neryva-website/src/pages/platform/AuthCallbackPage.tsx:50-73`; route table `console/neryva-website/src/router/routes.tsx:183-190` (`inviteRoute` top-level public); session `console/neryva-website/src/lib/engine/auth.ts` (hydrate/refresh); org context `console/neryva-website/src/Context/OrgContext.tsx:40-44,52,130-182` (`neryva.active_org` + `X-Neryva-Org` + `adoptOrg`); stash `console/neryva-website/src/lib/engine/invite-stash.ts:14-132`; hooks `console/neryva-website/src/hooks/auth/useFirstRun.ts:62-98` (preview/redeem) + `console/neryva-website/src/hooks/engine/mutations.ts:53-139` (invite/member writes) + `console/neryva-website/src/hooks/engine/queries.ts:34-78` (members/invites/summary reads); capabilities `console/neryva-website/src/lib/engine/capabilities.ts:48-68`; errors `console/neryva-website/src/lib/engine/errors.ts:35-173`; invite page `console/neryva-website/src/sections/pages/platform/invite/InviteSection.tsx:79-382` + `console/neryva-website/src/pages/platform/InvitePage.tsx:11-18`; members page `console/neryva-website/src/pages/platform/OrgMembersPage.tsx:69-291`; teams `console/neryva-website/src/sections/pages/products/agent-studio/teams/TeamsView.tsx:99-687`; home banner `console/neryva-website/src/pages/platform/PlatformHomePage.tsx:118-145`.

Backend connection standard (all team-loop server state lives in TanStack Query custom hooks; `engine()` is transport only, never called from views for cached reads):

| UI / flow | Hook | Endpoint | Key (invalidator) |
|---|---|---|---|
| Member inventory | `useMembers` | `GET /console/org/:orgId/members?q&status&limit&offset` | `['engine','members',orgId,params]` |
| Invite list | `useInvites` | `GET /console/org/:orgId/invites` | `['engine','invites',orgId]` |
| Org summary / seats | `useOrgSummary` | `GET /console/org/:orgId/summary` | `['engine','org-summary',orgId]` (15s) |
| Invite create | `useInviteMember` | `POST :orgId/invites {email,role,delivery?}` uuidv7 | `['invites','org-summary']` on success |
| Resend / extend / revoke | `useResendInvite/useExtendInvite/useRevokeInvite` | `POST :id/resend {delivery?}` / `POST :id/extend {days}` / `POST :id/revoke` | `['invites']` (+ summary where noted) |
| Role / suspend / reactivate / remove / leave / transfer | `useChangeRole/useSuspendMember/useReactivateMember/useRemoveMember/useLeaveOrg/useTransferOwnership` | `PATCH :accountId/role` / `POST :accountId/suspend|reactivate|remove` / `POST members/leave` / `POST transfer-ownership` | `['members','home']` family |
| Invite preview | `useInvitePreview` (`retry:false`) | `POST …/invites/:id/preview` (body token) | `['auth','invite-preview',id]` |
| Invite redeem | `useRedeemInvite` | `POST …/invites/:id/redeem` (body token, uuidv7) | explicit adopt + home refetch |

Documented deviations from `hooks/engine/mutations.ts` shape (intent preserved): no toasts in `useFirstRun` preview/redeem (exact inline copy per §5 tables — a generic toast would double-report); `useRedeemInvite` skips `useOrgRequired` on purpose (redeem runs outside any org scope by design); `useInvitePreview` sets `retry:false` (a 404 is a terminal answer, never burn budget).

---

## 3. T1 — Invite creation (owner/admin only)

**Goal:** an owner/admin invites by email+role+delivery; Engine enforces every guard; the UI never offers what the server would refuse (but the server remains authoritative).

**Engine (DONE — verify, do not rebuild):**

```text
members page → POST :orgId/invites {email, role, delivery?: 'email'|'manual'}
  → assertInvitableRole (owner excluded by construction)
  → normalizeInviteDelivery fail-closed (DTO whitelists first)
  → normalizeEmail trim+lowercase
  → 409 already-active-member
  → 409 member_suspended + reason (reactivate-instead; inviting would silently reactivate via addMember upsert)
  → 409 pending-duplicate (revoke/resend first)
  → 409 pending-ceiling (ORG_MAX_PENDING_INVITES=100)
  → insert {orgId,email,role,tokenHash:sha256(token),invitedBy,expiresAt:+7d}
  → audit org.invite_created {role,ttl_days} + OrgInviteCreated
  → email path: sendTemplate org.invite {inviter,org_name,role,ttl_days,accept_url}; manual path: return accept_url once
```

**Frontend:**

- Entry: members page → email + role picker (`admin | billing | developer | reader` — owner absent by construction; `ASSIGNABLE_ROLES` `console/neryva-website/src/pages/platform/OrgMembersPage.tsx:28` + hint `259` "Ownership is transferred, never invited") → delivery choice (§4 T2) → `POST :orgId/invites` (`@Idempotent`, rate-limited).
- Inviting AS admin is owner-only + step-up (`org-members.controller.ts:202-208`): UI MUST hide/disable the `admin` option for non-owners and collect `X-MFA-Proof` for owners (see T1-2).
- Pending row shows computed status (pending/accepted/revoked/expired — never stored, derived per read).

**Tasks:**

- [ ] T1-1 Engine guards verified (no code unless §9 E0 finds drift): `CreateInviteDto` whitelist `org-members.controller.ts:21-38` + `normalizeInviteDelivery` `invites.service.ts:430-435` + guard order `invites.service.ts:62-101` + `INVITABLE_ROLES` `schema.ts:175` + ceiling `env.ts:122` + `toView` `invites.service.ts:404-421` + list cap 500 `invites.service.ts:116-119`. Exit: `rg` proves audit `details` carry role/TTL only, no token/URL.
- [ ] T1-2 Frontend invite modal: delivery selector + owner-only `admin` gate + MFA proof field. Files: `console/neryva-website/src/pages/platform/OrgMembersPage.tsx:72-75,91,229-273` (`needsProof = inviteRole==='admin'`, `RoleSelect 254`, `TextInput invite-mfa 261-270`) + `console/neryva-website/src/sections/pages/products/agent-studio/teams/TeamsView.tsx:99,633-687` (`INVITE_ROLES`, `InviteModal`, no MFA field today) + `console/neryva-website/src/hooks/engine/mutations.ts:53-63` (`useInviteMember` must send `delivery`, accept `accept_url/expires_at`, keep `idempotent:true`). Exit: admin option hidden for non-owners; owner inviting as admin collects proof; `delivery` rides the body (idempotency fingerprint `idempotency.ts:54-56` replays original decision; switching method with same key correctly 409s — to switch method use Resend).
- [ ] T1-3 Pending lifecycle ops wired with exact copy: resend (rotate+reset+TTL, cap 5, rotation-guarded `invites.service.ts:174-183`), extend (token unchanged, ≤30d `ExtendInviteDto 46-51`), revoke (link dies immediately). Files: `OrgMembersPage.tsx:205-216` (status pill + Resend/Extend/Revoke) + `mutations.ts:65-87`. Exit: resend returns new shown-once link when `delivery=manual` (T2); extend surfaces `409` verbatim; revoke removes pending immediately.
- [ ] T1-4 Suspended-reinvite copy verbatim: creation `409 member_suspended` (`invites.service.ts:80-84`) MUST render "this email belongs to a suspended member — reactivate them in the Members tab instead" with a reactivate focus link — never a generic toast. Files: `mutations.ts:53-63` `onError` path + `OrgMembersPage.tsx` invite modal. Exit: manual QA invites a suspended address → exact copy + link.

**Edge cases (must hold):** inviting existing active member → 409 `already a member`, not a second row (unique `(account,org)` `schema.ts:40`); inviting suspended → 409 reactivate-instead (no silent reactivation via `addMember` upsert `memberships.service.ts:289-292`); removed/nonexistent proceeds; pending duplicate → 409 with `invite_id`; ceiling → 409 with cap count; `delivery` unknown → 422 fail-closed.

---

## 4. T2 — Delivery methods + share UX (URL-first, email retained)

**Goal:** operators can invite even when invite mail is quarantined; the raw link is shown ONCE and never leaks again.

| | Email (backend unchanged) | Manual / copy-link (PRIMARY) |
|---|---|---|
| Admin action | email + role → Done | email + role → success panel |
| Engine does | creates invite + sends `org.invite` email | creates invite, sends NOTHING |
| Response | `{inviteId, email}` (no URL — nothing to leak) | `{inviteId, email, accept_url, expires_at}` — shown ONCE (`expires_at` is non-secret metadata the mailto draft needs) |
| Admin shares via | — (already sent) | Copy button + "Compose email" (`mailto:` draft, §4.1) + forward in Slack/own mailbox |

Engine contract (implemented — T2 engine tasks are verify-only):

- `POST :orgId/invites {email, role, delivery?: 'email'|'manual'}` — default `email` = today's behavior byte-for-byte. `manual` skips `sendInviteEmail` and returns `accept_url` one time.
- `POST :orgId/invites/:id/resend {delivery?}` — same rule; manual resend returns the NEW `accept_url` once (old link already dead by rotation).
- List / detail / extend NEVER return URL or token (hash-only storage makes re-display impossible without rotation — state it in UI copy: "for security this link is shown once — resend to generate a new one").
- Audit rows never contain token/URL (current `details` carry role/TTL only — keep it; add a log-grep gate on a known-issued token).
- `accept_url` host is server-built from config (`ENGINE_UI_BASE_URL || ENGINE_BASE_URL` via `inviteUrl()`), never from request `Host`.
- Rate limits, guards, idempotency unchanged. Verified: `@Idempotent` fingerprint is method+path+body-hash (`idempotency.ts:54-56`), so the delivery flag rides it — a retried create with the same key replays the original decision instead of minting a second invite, and switching method with the same key correctly 409s. To switch method use Resend with the new flag — a fresh create would hit the pending-duplicate guard, not duplicate.

**Frontend share UX (MISSING — the ship blocker):**

- Success panel (manual only): masked link field with reveal-while-open + **Copy** (clipboard + "copied" confirm, reuse `CopyButton` — the same pattern `TeamsView.tsx:600-607` uses for service-account token reveal) + **Compose email** button opening `mailto:{invitee}?subject=…&body=…` prefilled by the template below + **Done** (masks permanently; panel unmounts, secret leaves memory, no telemetry).
- Auto-generated draft (the "email for them"): subject `You've been invited to {org} as {role}`; body: inviter line (`{actor} invited you…`), what the role can do (one line per §6 role table), link on its own line, expiry line (`valid {N} days` from `expires_at`), mismatch warning ("sign in with {email} — other addresses will be rejected"). No PII beyond what the admin typed; link excluded from any telemetry.
- Invite landing page sets `Referrer-Policy: no-referrer` (link in URL must not leak to analytics/embeds).
- Pending-row actions per method: email → Resend (re-emails rotated link) / Revoke / Extend; manual → Resend (returns new shown-once link AND, if delivery flipped to email, sends it) / Revoke / Extend / Copy is NOT re-offered (rotation-only re-access).

**Tasks:**

- [ ] T2-1 Engine delivery verified: `CreateInviteDto/ResendInviteDto` `org-members.controller.ts:21-44` + `create 61-114` + `resend 153-199` + `inviteUrl 338-345` + hash-only `schema.ts:51` + `toView` no hash `404-421` + audit clean `356-364,192,227`. Exit: manual create returns `accept_url` once; list/detail/extend return none; `rg token` hits only `*.token` redact paths.
- [ ] T2-2 Frontend `delivery` plumbing: `useInviteMember` type `{email,role,delivery?:'email'|'manual'}` body `{email,role,delivery}` response `{inviteId,email,accept_url?,expires_at?}` + `useResendInvite` type `{inviteId,delivery?}` body `{delivery}` response `{expires_at,accept_url?}`. Files: `console/neryva-website/src/hooks/engine/mutations.ts:53-71` + `console/neryva-website/src/hooks/engine/queries.ts:61-77` (`InviteRow` gains `delivery`/method badge source — server does not store delivery; derive per-row from last create/resend UI state OR omit badge and branch actions by "has ever returned accept_url this session" — decision recorded here before build; never invent a server column). Exit: `delivery` sent; default `email` keeps today byte-for-byte.
- [ ] T2-3 Shown-once success panel (manual only): masked `accept_url` reveal-while-open + `CopyButton value={accept_url}` + `Compose email` `mailto:` template + `Done` clears secret from state and unmounts. Files: `OrgMembersPage.tsx:229-273` (do NOT `setInviteOpen(false)` on manual success — render panel instead) + `TeamsView.tsx:633-687` (same). Show-once copy: "for security this link is shown once — resend to generate a new one". Exit: Copy copies exact URL; Done permanently masks; secret never in `localStorage`, never in toast, never in telemetry.
- [ ] T2-4 `mailto:` draft template: subject `You've been invited to {org} as {role}`; body inviter line + role one-liner (`ROLE_SUBTITLES` `OrgContext.tsx:25-31`) + link alone on line + `valid {N} days` (derived from `expires_at`) + mismatch warning `sign in with {email}`. Exit: draft opens with all five lines; link excluded from analytics.
- [ ] T2-5 `Referrer-Policy: no-referrer` on the invite landing page: `<meta name="referrer" content="no-referrer">` in `InvitePage.tsx:12-16` Helmet AND global `index.html` fallback. Exit: `rg -n referrer` hits both; manual QA shows no `Referer` on outbound clicks from `/platform/invites/*`.
- [ ] T2-6 Pending-row per-method branching: email rows Resend/Revoke/Extend; manual rows Resend(+new link/flip)/Revoke/Extend; Copy NOT re-offered without rotation. Files: `OrgMembersPage.tsx:200-227` + `TeamsView.tsx:276-292`. Exit: no Copy on a stored row; resend with flipped `delivery` follows §4 contract.

---

## 5. T3 — Accept flow (new vs existing user — one path, fork at identity)

**Goal:** an invitee goes email-link → (preview → sign-in if needed) → lands in the inviter's org with context, or gets an honest, escapable error. No strandings. (Engine DONE; Frontend DONE except T2-5 referrer.)

```text
GET /platform/invites/:inviteId?token=   ← frontend owns this route (exists: routes.tsx:183-190)
  → stash {inviteId, token, savedAt} in localStorage under `neryva.pending_invite`
    (newest wins). NOT sessionStorage: mobile OAuth app-switches and new-tab
    sign-ins lose tab-scoped storage and strand the user post-callback.
    Consume-and-delete on use; ignore when older than 30 min; the invite page
    re-stashes from ?token= on every load so total storage loss self-heals
    via the email link, and the invite URL itself is the post-login return
    target for the same reason.
  → if anonymous: OAuth (any provider) → callback → return here
  → preview (side-effect free): org name, inviter, ROLE being granted, expiry
      — the invitee sees what they accept BEFORE clicking (role-on-invite rule).
      POST console/org/invites/:inviteId/preview with {token} in the JSON BODY
      — never the query string (proxies/CDNs log url+query; Engine Fastify logs
      record url with query outside redact paths logger.ts:19-59 which cover
      headers/body *.token but NOT req.url; bodies appear in neither).
      Returns ONLY {org_name, role, expires_at, invited_by (display name, never
      email), email_hint (j***@acme.com masked)}.
      Rules: hash-only comparison; uniform generic error for
      missing/revoked/expired/accepted/locked (same status/body/timing); strict
      IP-scoped rate limit; token never logged, never in audit;
      Referrer-Policy: no-referrer on the page.
      No membership data, no email echo beyond the masked hint.
  → [Accept] → POST …/invites/:inviteId/redeem
  → Engine (invites.service.ts:237-300): hash match → liveness (not revoked/
    accepted/expired, attempts < 5) → session-email == invite-email (403) →
    addMember (seat/member caps checked HERE; refusal keeps invite usable) →
    single-use claim (conditional update — concurrent double-click is safe) →
    audit + OrgInviteAccepted event → returns {orgId, role}
  → set active org = redeem.orgId (never contexts[0]) → role-scoped dashboard
    + "invited by X as {role}" context banner
```

- **New user:** OAuth auto-creates the account (plus its own background personal org via unconditional `AccountCreated` listener `org-access.service.ts:38-42` — expected, stays in picker). No second OTP/email proof: the OAuth IdP verification IS the identity proof; the invite token only selects the pending grant.
- **Existing user:** no re-registration; membership attaches to the current account. No duplicate account is possible (email is the unique identity; `upsertByEmail`).
- **Wrong-email session:** 403 + "invitation was sent to {email} — switch accounts" (account-switch action, stash retained). Never auto-create or auto-link across addresses (takeover-by-unverified-email stays impossible).
- **Expired/revoked/used:** uniform invalid-invite screen + "Continue to my workspace" exit (brand-new users already own a personal org — first-run §2 rule).
- **Seat-full:** "workspace is full — ask an owner, invitation stays valid" + retry (invite deliberately unburned).

**Tasks:**

- [ ] T3-1 Route + stash (DONE — verify): `inviteRoute` top-level public `router/routes.tsx:183-190` (never under guarded shell) + `InvitePage.tsx:11-18` public shell + `invite-stash.ts:14-76` (`STASH_KEY neryva.pending_invite`, `INVITE_STASH_MAX_AGE_MS 30m`, newest-wins `writeInviteStash`, shape-guarded age-gated `readInviteStash`, `clearInviteStash` on success/terminal) + re-stash every load `InviteSection.tsx:115-119` + never mix across ids `InviteSection.tsx:109-113` + post-login precedence `post-login.ts:64-79` + URL self-heal `inviteDestinationFromPath 39-62`. Exit: stash survives new-tab/app-switch; 30-min expiry respected.
- [ ] T3-2 Preview integration (DONE — verify): `useInvitePreview` `useFirstRun.ts:62-77` (`POST …/preview` body token, `retry:false`, `staleTime 30s`) + `InviteSection.tsx:211-293` (no-creds → incomplete screen never fetches; `isPending` → loading; `isTransportError 75-77` (`0/429/>=500`) → retry `242-250`, never the invalid screen; else uniform invalid `255-260`; preview-ok renders `org_name/role/invited_by/email_hint/expires` `265-293` + masked-hint copy). Exit: scanner POSTs change no state (replay 10×, still pending, attempts untouched); wrong token indistinguishable from expired.
- [ ] T3-3 Sign-in handoff (DONE — verify): anonymous CTA `Sign in to accept` `InviteSection.tsx:350-363` (`beginLogin()` falls back to invite URL `131-138`, stash already holds credentials) vs authenticated `Accept invitation` `296-312`; callback returns via `resolvePostLoginDestination` `AuthCallbackPage.tsx:50-73`. Exit: anonymous open → preview card → sign in → lands back with stash.
- [ ] T3-4 Redeem integration (DONE — verify): `useRedeemInvite` `useFirstRun.ts:87-98` (body token, uuidv7) + `acceptInvite` `InviteSection.tsx:140-168` (single-flight `working/loading-org` guard `141`, `mutateAsync`, `clearInviteStash 148`, `writeInviteBanner 150-155`, `adoptOrg 161` BEFORE `navigate 168`, best-effort home refetch `164` still advances on failure). Exit: lands in inviter org, never `contexts[0]`; banner shows `"<invited_by> invited you to <org> as <role>"`.
- [ ] T3-5 Exact failure copy (DONE — verify, see table §7): 403 mismatch → switch-account (stash retained); 409 expired/revoked/locked/used → invalid + workspace exit (stash cleared — terminal); seat/member-cap → full + retry (stash retained); 401/400 invalid → terminal-invalid (single-flight, no 401 loop); transport → failed + retry (retained). Files: `InviteSection.tsx:169-198,296-348`. Exit: every row of §7 renders verbatim.
- [ ] T3-6 Stash lifecycle (DONE — verify): clear on success + terminal (expired/revoked/used/invalid `InviteSection.tsx:148,180,190`); RETAIN on retryable (seat-full, mismatch, transient `172,176,196`); ignore >30 min at router time `invite-stash.ts:60-62`; re-fire safe (`@Idempotent` + `org-invite-redeem` limit `org.controller.ts:169`). Exit: no-loop guard on 401 proven.
- [ ] T3-7 Copy + a11y pass: labels, `role=alert` errors, focus order, keyboard-only accept run. Exit: keyboard-only preview→accept completes.

Redeem failure copy (exact Engine semantics — render these, not generic errors):

| Engine outcome | UI copy |
|---|---|
| 403 `sent to a different email address` (`invites.service.ts:261-264` — redemption requires the session email to match the invite) | "This invitation was sent to {email_hint}. Sign in with that address to accept — your invitation stays valid." + account-switch action (`logout`) |
| 409 expired / revoked / locked / already-used (`invites.service.ts:251-259,280-287`) | Uniform invalid-invite screen WITH a "Continue to my workspace" exit — a brand-new user already owns a fresh personal org (unconditional autocreation `org-access.service.ts:38-42`), so never trap an authenticated user on an error page. The button routes to dashboard (personal org via F1 freshness/`needsOnboarding` gate) |
| 409 seat-full / member-cap (`seatLimitReached`, `organization is at its member cap` — `memberships.service.ts:278-281,314-316`; invite stays usable by design, `invites.service.ts:267-271`) | "This workspace is full. Ask an owner to add seats, then retry — your invitation is still valid." + retry button (do NOT burn the token client-side). Member cap is abuse posture, not billing — same retryable pattern. Re-activating a removed member consumes no additional seat |
| 401 `Invalid invitation` (+attempt) / 400 DTO length guard on hand-crafted token | Terminal-invalid (attempts burn server-side; do not auto-retry in a loop — one retry max via explicit user Retry, then invalid screen) |
| Transport (offline/5xx/429) | "Couldn't reach the service. Check your connection — your invitation is still valid." + retry (stash retained; never the invalid screen — an invalid verdict on a live invite would be a lie) |

---

## 6. T4 — Role model and admin powers (the complete matrix)

Roles: `owner | admin | billing | developer | reader` (`ORG_ROLES` `schema.ts:172-173`). Ownership is singular per org as a **partial unique DB index** (`uq_one_active_owner_per_org`, `drizzle/0044`) — the index enforces the UPPER bound only (never two active owners, even under concurrent transfer); the LOWER bound (≥1 owner) is application-enforced (`assertAnotherOwnerRemains` on remove/leave/demote + `changeRole` transfer rules), deliberately, so the org purge (which deletes all memberships) is never DB-blocked.

| Action | Owner | Admin | Billing/Developer/Reader |
|---|---|---|---|
| View members/invites/groups/service accounts | ✅ | ✅ | ✅ (all roles read the inventory) |
| Invite billing/developer/reader | ✅ | ✅ | ❌ |
| Invite as admin | ✅ + step-up MFA | ❌ (`only an owner may invite someone as admin`) | ❌ |
| Assign `owner`/`admin` | ✅ + step-up MFA | ❌ (`only an owner may assign…`) | ❌ |
| Change lower roles | ✅ | ✅ | ❌ |
| Suspend / reactivate members | ✅ (except owner targets and self — owners are immune to suspend: transfer or remove instead; nobody suspends their own membership) | ✅ except owner targets and self | ❌ |
| Remove a member | ✅ (except the owner: transfer instead — removal of the sole owner is structurally impossible) | ✅ except owner/admin targets | ❌ |
| Transfer ownership | ✅ + step-up | ❌ | ❌ |
| Resend / revoke / extend invites | ✅ | ✅ | ❌ |
| Manage groups, service-account tokens | ✅ | ✅ | ❌ |
| Leave org self-service | ✅ (non-last; last must transfer first) | ✅ | ✅ |
| Billing surfaces | ✅ | ❌ (read where listed) | billing role ✅ |

Enforcement order per request (industry rule, Engine implements): membership → role → ownership/sharing. `getRole` resolves from `active` rows only — suspension/removal is an immediate, session-independent lockout; no "still logged in so still allowed" gap. Support impersonation (`principal.imp`) is read-only on all mutating member/invite routes (`org-roles.guard.ts:49-54` + per-controller `if (principal.imp) → 403`).

Offboarding posture: **suspend before remove** (suspend keeps the row + history, cheap recovery; remove is the clean exit; both audited with actor + email). Resources are org-owned, so nothing strands on removal; leaver history stays attributable.

**Tasks:**

- [ ] T4-1 Engine matrix verified: `Roles(...)` on every route `org-members.controller.ts:78-79,101-102,107-108,132,146,160-161,182-183,191-192,215-216,221-222,236-237,252-253` + imperative owner+step-up `changeRole 118-124` / `createInvite admin 202-208` (`assertFreshMfaProof`) + `removeMember` admin-target block `171-176` + `memberships.service.ts` (`changeRole 326-367`, `suspend 374-406` self+owner immune, `reactivate 408-436`, `remove 438-465` groups follow, `leave 468-489` last-owner, `transfer 291-370` demote-promote TX + post-condition, `getRole 507-521` active-only + heartbeat, `assertAnotherOwnerRemains 544-554`, `translateOwnerInvariant 50-56`) + `OrgRolesGuard 46-63`. Exit: matrix table above holds per role via manual role-swap QA (§11).
- [ ] T4-2 Frontend role gating (PARTIAL → fix): `canManageMembers = role==='owner'\|\|role==='admin'` `OrgContext.tsx:184` + `canPerform` matrix `capabilities.ts:48-68` (product `:read` every role while reads alive; `:write/:publish/:operate` owner/admin/developer live-only; `billing:view` owner/admin/billing; `billing:manage` owner/billing; `audit:view` everyone-but-reader) + `useCan(product)` `capabilities.ts:75-79`. Fixes: (a) hide/disable `admin` role option for non-owners (`OrgMembersPage.tsx:91,142-151,254` + `TeamsView.tsx:99,676-682` — server 403 today but UI offers it); (b) ungate invites list for readers (`OrgMembersPage.tsx:183` `canManageMembers && Pending` hides from reader/billing/developer — spec says all roles read; keep Resend/Revoke/Extend disabled with `title="Need owner/admin"`); (c) block admin remove of non-owner/admin correctly (`OrgMembersPage.tsx:171` today `role==='owner'`-only remove — spec allows admin to remove billing/developer/reader; change to `targetRole==='owner' → hide` not actor-role check); (d) add self-suspend/self-remove guard (`member.accountId !== me` — server 409/403 but UI allows the click); (e) change-to-`owner/admin` demands MFA proof field (reuse `needsProof` pattern + `isStepUpRequired` retry `mutations.ts:31-37`). Exit: §6 table holds in UI with server as fallback, never the boundary.
- [ ] T4-3 Suspend/reactivate/remove/leave/transfer wired with exact copy: suspend `org.member_suspended` + email, reactivate `org.member_reactivated`, remove `ConfirmDialog` `OrgMembersPage.tsx:275-288` ("They immediately lose access… Group memberships are cleaned up too."), leave `useLeaveOrg` `mutations.ts:127-139` clears `neryva.active_org` + invalidates `['engine']`, transfer `useTransferOwnership` `mutations.ts:292-299` (`mfaProof` required, `act:'Transfer ownership'`). Exit: last owner cannot leave/remove-self before transferring (409 copy verbatim `memberships.service.ts:551-553`); suspended in-flight session denied on next request (guard re-check, not just UI hide).
- [ ] T4-4 Groups + service accounts (owner/admin): `useGroups/useServiceAccounts` `queries.ts:125-152` + `useCreateGroup/useDeleteGroup/useAddGroupMember/useRemoveGroupMember` + `useCreateServiceAccount/useRotateServiceAccountToken/useDisableServiceAccount/useEnableServiceAccount/useDeleteServiceAccount` `mutations.ts:200-271` + `TeamsView.tsx:44-80,600-613` (token reveal `TokenReveal` + `CopyButton` once, rotation voids previous `TokenRevealText`). Exit: tokens fingerprints-only in lists (`hasToken/tokenPrefix` only), secrets shown once + copy + never re-fetchable.

---

## 7. T5 — New-member dashboard experience

- Org picker shows the new org with role badge (`ROLE_LABELS/ROLE_SUBTITLES` `OrgContext.tsx:18-31`, `ROLE_TONES` `TeamsView.tsx:91-97`); active org persists via `OrgContext` (`neryva.active_org` `OrgContext.tsx:52,76-78,130-140` + `setActiveOrg` header `136-140`).
- Role-gated chrome: owners/admins see members/settings/billing; developers see build surfaces; billing sees money surfaces; readers see lists + conversations/runs, no mutating actions. Every hidden control has a server guard behind it (hidden button = UX, never the boundary — `capabilities.ts` + `OrgRolesGuard`).
- Guided first collaborative action within the session: open a shared conversation or run the team's published assistant (test-run where safe). Checklist shows team-flavored items (meet the workspace, run the team assistant) rather than setup items the member cannot complete.
- Notifications (all verified in `notifications.service.ts:131-206`): new member gets in-app `org.member_added`; suspended → warn; reactivated → info; removed → warn (never on self-leave); existing accounts get an in-app `org.invite_created` row alongside the email; owners/admins get `org.invite_accepted` feed rows. Role changes send a direct `org.role-changed` email from the memberships flow (`memberships.service.ts:360-366`) plus audit `org.member_role_changed`.

**Tasks:**

- [ ] T5-1 Org picker + persistence (DONE — verify): `OrgContext.tsx` (`stored/override/adopted` state `76-82`, cross-tab `storage` listener `104-112`, `active` memo `114-128` null-during-adopt never wrong org, persist effect `130-134`, `setActive` pre-check `150-166`, `adoptOrg` `167-182` header+storage immediate + `invalidateOrgScope`). Exit: hard reload keeps team org; stale/foreign id falls back, never rides `X-Neryva-Org`.
- [ ] T5-2 Role-gated chrome (PARTIAL → fix per T4-2): `useCan` + `canManageMembers` gates on nav/menus (content a role can never see → hidden; content usable with different role/plan → disabled + `title` why). Exit: reader direct-links to admin action → hidden AND denied (403).
- [ ] T5-3 Join banner (DONE — verify): `writeInviteBanner/readInviteBanner/clearInviteBanner` `invite-stash.ts:78-132` (tab-scoped `sessionStorage`, dies with tab — describes THIS tab's navigation, not a credential; dismissed explicitly, never auto) + `PlatformHomePage.tsx:63-78,118-145` (`InviteBanner role="status"`, shown only while `banner.orgId === orgId 122`, explicit Dismiss `123-126`). Exit: banner `"<invited_by> invited you to <org> as <role>"` once, survives no reload beyond tab, never misattributed after org switch.
- [ ] T5-4 Guided collaborative CTA (MISSING → build): post-join home shows "meet the workspace, run the team assistant" team-flavored checklist for invitees (vs setup items they cannot complete). Files: `PlatformHomePage.tsx:147-219` (`KpiGrid` seats/members + `CardGrid` products today) + `useOnboarding` checklist. Exit: invitee sees collaborative first action (shared conversation / run team assistant test-run where safe), not settings they cannot touch.

---

## 8. T6 — Audit + notifications evidence

**Tasks:**

- [ ] T6-1 Audit coverage (Engine DONE — verify + grep gate): `org.invite_created/resent/extended/revoked/accepted`, `org.member_added/role_changed/suspended/reactivated/removed/left`, `org.ownership_transferred` (+ deletion/data_exported/purged) — queryable per org (`GET :orgId/audit` + facets/export/verify — M6), resource IDs present, details role/TTL/email/counts only, **no raw tokens anywhere**. Files: §2 C23 sources. Exit: `rg -n "token|accept_url" engine/src/modules/organizations/invites.service.ts` hits only hash/token-var lines, never `audit.add details`; log-grep on a known-issued token across the stream returns zero (preview `POST` body redacted `logger.ts:35`, `req.url` never carries it by construction `org.controller.ts:179-189`).
- [ ] T6-2 Notifications wiring (Engine DONE, Frontend M1.3): `notifyAccount/notifyOrgRoles` `notifications.service.ts:131-206` + `notifyMember` emails `memberships.service.ts:534-542` + `OrgInviteCreated` for existing accounts only `notifications.service.ts:178-196` + `OrgInviteAccepted` to owner/admin `198-206` + role-change email `memberships.service.ts:360-366`. Frontend: `NotificationsPopover` re-pointed to `GET /console/notifications` + `POST …/:id/read` + `read-all`, badge from `unread`, per-kind `data.target` deep-link (`org.invite_created` + member/role/billing kinds) — `ledger.md:104` M1.3. Exit: new member sees `org.member_added`; owners see `org.invite_accepted`; suspended/removed see warn rows; role change arrives by email + feed.
- [ ] T6-3 Email templates verified: `org.invite` (`inviter,org_name,role,ttl_days,accept_url` `invites.service.ts:369-383`), `org.role-changed`, `org.member-suspended/removed`, `org.ownership-transferred`, `org.deletion-requested/cancelled`. Exit: `accept_url` host is config-built (C4); templates never log the token.

---

## 9. Status board

| ID | Item | State |
|---|---|---|
| T1-1 | Engine invite-create guards (role/delivery/email/active/suspended/duplicate/ceiling/status/invariants) | done (verify-only) |
| T1-2 | Frontend invite modal: delivery selector + owner-only admin + MFA proof + `delivery` plumbing | done (`OrgMembersPage.tsx:229-273` + `TeamsView.tsx:633-687` + `mutations.ts:53-94`) |
| T1-3 | Pending resend/extend/revoke with exact copy + caps | done (resend delivery-aware + rotation guard; extend ≤30d server-clamped; revoke immediate) |
| T1-4 | Suspended-reinvite `409 member_suspended` verbatim + reactivate link | done (`OrgMembersPage.tsx` inline `InlineError` + `Find the suspended member` search focus; toast carries verbatim server copy) |
| T2-1 | Engine delivery + one-time URL + hash-only + audit-clean | done (verify-only + grep gate §11) |
| T2-2 | Frontend `delivery` types through `useInviteMember/useResendInvite` | done (`mutations.ts:53-94` `InviteDelivery`, `InviteCreateResult`, `InviteResendResult`; default `email` byte-for-byte) |
| T2-3 | Shown-once success panel (masked + Copy + Compose + Done, secret leaves memory) | done (`OrgMembersPage.tsx` `OncePanel` + `TeamsView.tsx` manual panel; `CopyButton` reuse; Done clears state, never `localStorage`/toast/telemetry) |
| T2-4 | `mailto:` draft template (subject/body/link/expiry/mismatch) | done (`buildMailto` `OrgMembersPage.tsx` + inline compose `TeamsView.tsx`; subject `You've been invited…`, role one-liner, link alone, `valid N days`, mismatch warning) |
| T2-5 | `Referrer-Policy: no-referrer` on invite landing (+ global fallback) | done (`InvitePage.tsx:19` Helmet + `index.html:25`) |
| T2-6 | Pending-row per-method branching (Copy NOT re-offered) | done (resend modal with delivery radio `OrgMembersPage.tsx`; Teams pending Resend (email) + Link (manual rotate + shown-once `rotated` panel with Copy/Done) + Revoke `TeamsView.tsx:PendingInvitesCard`; Copy only on fresh manual rotation, never on stored rows) |
| T3-1 | Route + stash (`/platform/invites/$inviteId`, `neryva.pending_invite` newest-wins 30m + self-heal) | done |
| T3-2 | Preview integration (body-only, uniform 404, masked hint, transport-vs-invalid) | done |
| T3-3 | Sign-in handoff (stash + return URL, URL re-stash self-heal, router precedence) | done |
| T3-4 | Redeem + banner + `adoptOrg` BEFORE routing (never `contexts[0]`) | done |
| T3-5 | Exact failure copy table (§5) | done |
| T3-6 | Stash lifecycle (clear on success/terminal; retain on seat-full/mismatch/transient; no 401 loop) | done |
| T3-7 | Copy + a11y pass | done |
| T4-1 | Engine role matrix + guards + transfer TX + seat/member caps + impersonation read-only | done (verify-only) |
| T4-2 | Frontend role gating (hide admin for non-owners, reader invite view, remove/suspend guards, MFA on assign) | done (`OrgMembersPage.tsx:142-173` owner-only admin options, invites readable by all roles with actions gated, self-suspend/self-remove blocked, admin-remove matrix `!(admin && admin-target)`; `TeamsView.tsx` pending readable by all) |
| T4-3 | Suspend/reactivate/remove/leave/transfer wired with exact copy + last-owner + immediate lockout | done (hooks + UI guards; server `getRole` active-only per-request; last-owner 409 verbatim; transfer step-up via `useTransferOwnership`) |
| T4-4 | Groups + service accounts (owner/admin, tokens once) | done (verify-only) |
| T5-1 | Org picker + `neryva.active_org` persistence | done |
| T5-2 | Role-gated chrome (hide vs disable + `title` why) | done (per T4-2; server remains authoritative) |
| T5-3 | Join banner (one-shot, tab-scoped, explicit dismiss) | done |
| T5-4 | Guided collaborative CTA (team-flavored checklist) | done (`PlatformHomePage.tsx:135-145` banner now names the collaborative first action — shared conversation / run the team's assistant — instead of setup items) |
| T6-1 | Audit coverage + no-token grep gate | done (verify-only) |
| T6-2 | Notifications wiring (feed + email + deep-links, M1.3) | engine done / frontend verify |
| T6-3 | Email templates (`org.invite` + lifecycle) | done (verify-only) |
| E0-1 | Engine suites green (`tsc --noEmit`, eslint, vitest, build) | done (2026-09-17: clean + 175 PASS + dist rebuilt) |
| E0-2 | `GET :orgId/invites/:inviteId` detail (hash-free `InviteView`) | done (`org-members.controller.ts:222-233` + `invites.service.ts:detail`; `toView` shared, never emits hash) |
| E0-3 | `@Idempotent()` on `resendInvite` (delivery rides fingerprint) | done (`org-members.controller.ts:235-243` docblock + decorator) |
| E0-4 | `removeMember` owner-tighten (spec-alignment) | done (`memberships.service.ts:438-447` unconditional `403 Owners cannot be removed — transfer ownership instead`; singleton-safe, matches `team-loop.md:19`) |
| E0-5 | Token/log/audit grep证明 + scanner/atomicity probes | done static legs (audit `details` token-free, `*.token` redacted, preview body-only); live scanner/concurrent probes → runbook §11 items 6-7 on a running stack |

**Done definition per item:** implemented + `tsc` clean (engine `--noEmit`, console `-b`) + `eslint` 0 errors on touched files + `vitest` green where covered + live probe per §11 + this ledger flipped to `done` with the verification noted. Static legs green before live legs; engine `dist` rebuilt before any live probe (inviteUrl/activation edits postdate older builds).

Full patch review rule (from `first-run-ledger.md` §6): every hunk read worktree-vs-HEAD before flip; findings fixed in review (private-mode `localStorage` hardening, transport-vs-invalid rendering, 400-as-terminal, section file conventions).

---

## 10. Deferred (explicitly not this release)

SCIM provisioning/deprovisioning, domain-claim auto-join, SSO-JIT, guest/restricted-member roles, temporary time-boxed grants, per-resource ACLs, invite-delivery telemetry columns. Each arrives only with an enterprise contract — the role/enforcement skeleton already supports them without migration (`schema.ts:172-175` roles extensible; `org-roles.guard.ts` matrix additive).

---

## 11. Live verification (runbook — Engine-first)

Engine-first order: prove the contract (E0) before consuming it (F1/F2). After `node --env-file=.env dist/main.js` in `engine/` (rebuild `dist` first — it must include §8 delivery/preview/suspended work):

0. Pre-flight: engine `tsc --noEmit` clean, `eslint` clean, `vitest` green, `npm run build` clean, `dist` rebuilt; console `tsc -b` + `eslint` clean. Record commits.
1. `GET :3001/login/providers` → `[{key:google}]`; Vite `:3000/engine/login/providers` → same (auth-adjacent sanity).
2. Owner/admin invites by email+role+delivery (`team-loop.md:139`): email path delivers link with NO URL in any response (`rg accept_url` on response); manual path returns `accept_url` ONCE; token never appears in any other API response, log, or analytics event (grep-proven: issue a known token, `rg` it across the log stream → zero; `rg` audit `details` → role/TTL only).
3. New-address invitee: OAuth → accept → member with invite role; no duplicate account (`upsertByEmail`); personal background org untouched (stays in picker).
4. Existing user: accept attaches membership; already-member gets "already a member" (`this email is already a member`), not a second row (unique `(account,org)`).
5. Wrong-email session → 403 + switch-account path (stash retained); expired/revoked/used → uniform invalid screen + `Continue to my workspace` workspace exit; seat-full → retryable "workspace full" (invite intact — `addMember` first, claim second); suspended address invited at creation → 409 `member_suspended` + reactivate-instead copy (no silent reactivation).
6. Preview is POST-only (GET → 404); scanner/prefetcher POSTs change no state (replay 10×, invite still pending, `attempts` untouched — preview registers none); wrong token reveals nothing distinguishable from expired (same 404 body/timing); raw token absent from request logs (grep a preview call's request-id across the log stream → no token; body redacted `logger.ts:35`).
7. Double-click/refresh/concurrent redeem → exactly one membership (conditional claim `where acceptedAt isNull revokedAt isNull` + upsert on `(account,org)`), idempotent replays return stored response (`Idempotent-Replay: true`); replayed `Idempotency-Key` with different body → 409 `idempotency_conflict`.
8. Admin cannot assign owner/admin (403 + step-up proof demanded of owner path — `assertFreshMfaProof`); cannot remove owner/admin (`Only an owner may remove an owner or admin`); last owner cannot leave/remove-self before transferring (`the last owner cannot leave or be demoted`).
9. Suspended member's in-flight session denied on next request (guard re-check `getRole` active-only — not just UI hide; prove with a suspended session hitting `GET :orgId/members` → 403).
10. Audit covers `org.invite_created/resent/extended/revoked/accepted`, `org.member_added/role_changed/suspended/reactivated/removed/left`, `org.ownership_transferred` — queryable per org (`GET :orgId/audit`), resource IDs present, no raw tokens anywhere.
11. Email normalization proven: invite `Alice@X.com` accepted by `alice@x.com` session (both lowercased at write/compare).
12. Manual share UX (F1): manual invite → shown-once masked link + Copy copies exact URL + `mailto:` prefill (subject/body/link/expiry/mismatch) + Done clears secret (state empty, no `localStorage`, no toast telemetry); email invite never shows URL; Copy NOT re-offered on stored rows (rotation-only); `Referer` absent on outbound clicks from `/platform/invites/*`.
13. Role chrome (F2): admin cannot select `admin` role; reader sees invites read-only; owner/admin suspend/remove matrix matches §6 table; no self-suspend; transfer demands step-up and leaves exactly one owner (concurrent transfer loses with 23505→`owner_already_present`).
14. T5-4 closes when an invitee lands in the inviter org with banner and sees the collaborative first action (shared conversation / run team assistant) instead of setup items they cannot complete.

---

## 12. Failure-copy quick reference (Engine → UI, verbatim)

| Engine | Code | UI |
|---|---|---|
| `this email is already a member of the organization` | 409 | Already-member notice, no second row |
| `this email belongs to a suspended member — reactivate them in the Members tab instead` + `reason: member_suspended` | 409 | Same sentence + reactivate focus link (creation path) |
| `an invitation for this email is already pending — resend or revoke it` + `invite_id` | 409 | Same sentence + link to the pending row |
| `the organization is at its pending-invitation cap (100)` | 409 | Same sentence (abuse posture) |
| `invitation reached its resend cap (5) — revoke and create a new one` | 409 | Same sentence |
| `invitation changed concurrently — reload and retry` | 409 | Same sentence (rotation race) |
| `Invalid invitation` | 401 (+attempt) | Terminal-invalid screen (no loop) |
| `Invitation is no longer usable` | 409 | Uniform invalid + workspace exit |
| `Invitation expired` | 409 | Uniform invalid + workspace exit |
| `Invitation locked after too many attempts` | 409 | Uniform invalid + workspace exit |
| `This invitation was sent to a different email address` | 403 (+attempt, usable) | Mismatch + switch-account (stash retained) |
| `seat limit reached` / `organization is at its member cap (500)` | 409/402-family (usable) | "workspace is full… still valid" + retry (stash retained) |
| `only an owner may invite someone as admin` / `only an owner may assign the owner or admin roles` | 403 | Same sentence + step-up prompt for owners |
| `Only an owner may remove an owner or admin` | 403 | Same sentence |
| `the last owner cannot leave or be demoted — transfer ownership first` | 409 | Same sentence + transfer CTA |
| `you cannot suspend your own membership` | 409 | Same sentence |
| `owners cannot be suspended — transfer ownership or remove the member` | 403 | Same sentence |
| `Idempotency-Key was already used with a different request body` | 409 | "This action was already submitted with different input" (`errors.ts:165-168`) |
| `invitation` (preview uniform) | 404 | "This invitation link is invalid or expired." + workspace/sign-in exit |

---

## 13. References

- `engine/docs/frontend/team-loop.md:13-20` (six answers), `:24-29` (creation), `:31-56` (1A/1B delivery+share), `:58-62` (email), `:64-111` (accept), `:107-128` (roles), `:130-135` (dashboard), `:137-148` (acceptance), `:150-152` (deferred), `:154-160` (work-list), `:164-170` (refs)
- `engine/src/modules/organizations/invites.service.ts:35-36,61-114,116-230,232-300,302-345,347-452` — guards, lifecycle, redeem, preview, URL, mask
- `engine/src/modules/organizations/org-members.controller.ts:16-51,66-265` — DTOs, routes, roles, step-up, idempotency, rate limits
- `engine/src/modules/organizations/org.controller.ts:161-199,201-231` — contexts, redeem, preview, settings PATCH
- `engine/src/modules/organizations/memberships.service.ts:50-56,83-164,182-234,245-317,326-367,369-489,507-567` — invariant, inventory, seat wall, lifecycle, guards, roles
- `engine/src/modules/organizations/org-lifecycle.service.ts:291-370` + `org-lifecycle.controller.ts:35-39` — transfer TX
- `engine/src/modules/organizations/schema.ts:26-43,45-63,172-175` — memberships, invites, roles
- `engine/src/modules/notifications/notifications.service.ts:131-206` — feed fan-out
- `engine/src/common/policy/org-roles.guard.ts:38-63`, `step-up.guard.ts:25-31`, `http/idempotency.ts:50-99`, `observability/logger.ts:19-59`, `config/env.ts:119-123,155,196-198`
- `engine/drizzle/0044_org_owner_invariant.sql:41-43`, `0045_org_kind.sql`
- `console/neryva-website/src/pages/platform/OrgMembersPage.tsx:28,69-291` — inventory + invite modal + pending table
- `console/neryva-website/src/sections/pages/products/agent-studio/teams/TeamsView.tsx:99-109,600-687` — teams invite modal + token reveal pattern
- `console/neryva-website/src/sections/pages/platform/invite/InviteSection.tsx:66-77,109-198,211-382` — stash/preview/redeem/copy
- `console/neryva-website/src/lib/engine/invite-stash.ts:14-132` — stash + banner
- `console/neryva-website/src/hooks/auth/useFirstRun.ts:62-98` + `hooks/engine/mutations.ts:53-139,292-299` + `hooks/engine/queries.ts:34-78` — reads/writes
- `console/neryva-website/src/Context/OrgContext.tsx:18-52,76-187` — roles, active_org, adoptOrg
- `console/neryva-website/src/lib/engine/capabilities.ts:48-79` + `lib/engine/errors.ts:35-173` — gating + copy
- `console/neryva-website/src/pages/platform/PlatformHomePage.tsx:63-78,118-160` — join banner + KPIs
- `console/neryva-website/src/router/routes.tsx:183-190` + `pages/platform/InvitePage.tsx:11-18` — public route
- Research: stateful-pending-grant pattern; least-privilege ladders with singular transferable owner; suspend-before-remove; membership→role→ownership check order.
