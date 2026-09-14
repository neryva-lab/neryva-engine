# Team Loop — Invite → Accept → First Collaborative Action

> Status: proposed plan (not yet implemented).
> Owner: Frontend team + Engine platform team.
> Scope: **the complete membership lifecycle in the console** — invite creation, email delivery, accept (new + existing users), role model and admin powers, the new-member dashboard experience, suspension/removal/leave/transfer, and the audit/notification evidence for each step.
> Non-goals: changing Engine membership semantics (all cited behavior already exists), SCIM/domain-claim/SSO-JIT (deferred until deal-size justifies — hooks noted in §7), per-resource ACLs (org roles only this release).
> Explicitly IN scope as specified engine additions (§8 work-list, not yet implemented): delivery-method flag on invite create/resend + one-time `accept_url`, and the public invite-preview endpoint. Everything else cited already exists.
> Research basis: stateful-pending-grant invite pattern (server-side grant + short-lived claim token + atomic accept binding session-email to invited-email), least-privilege role ladders (owner/admin/member/viewer + billing/developer here), suspend-before-remove offboarding, single-org-context enforcement.
> Verification: Engine citations re-checked against `engine/src` on 2026-09-15. Paths repo-root-relative.

---

## 0. Answers first (the six questions, each verified)

1. **Does the admin generate the link and send it?** The admin enters **email + role + delivery choice** (§1A): Engine-emailed (backend unchanged) or a shown-once link the admin copies/forwards themselves (primary path). The raw token is returned ONLY in the one-time manual response, stored as hash-only, and never logged — there is nothing persistent to leak from devtools, logs, or screenshots. Resend rotates the token (old link dies immediately) under both methods.
2. **Must the member already be a user?** No. Invite by email works for nonexistent accounts. At accept time: existing account → membership attaches; new address → user completes OAuth first (account auto-creates), then redeems. The binding rule is email equality, not prior existence.
3. **Enter URL → email match → enroll?** Exactly: link `/platform/invites/:inviteId?token=` (Engine-generated shape — the frontend must own this route, it does not exist yet) → OAuth if anonymous → `POST …/invites/:inviteId/redeem` → Engine checks hash, expiry, revocation, attempt cap, then requires **session email == invite email** (403 otherwise) → membership row with the invite's role → invite claimed single-use. All-or-nothing ordering is server-side (membership first so seat-full doesn't burn the invite; claim guarded so double-redeem is idempotent).
4. **Who is the admin — the org creator?** The creator is the **owner**, which outranks admin. Exactly one active owner per org is a **database invariant** (partial unique index `uq_one_active_owner_per_org`, `drizzle/0044`), not application convention. Ownership moves only via explicit step-up-gated transfer — never by invitation (`INVITABLE_ROLES` excludes owner).
5. **Can that admin see everyone and change/remove them?** Member list is visible to **all** roles (including reader). Owner/admin can invite, suspend, reactivate, remove, resend/revoke/extend invites, and manage groups + service accounts — with owner-only reserves: assigning `owner`/`admin` roles (owner-only + fresh MFA proof) and removing an admin (owner-only). Owners cannot be removed at all — only transferred out (the exactly-one-owner index makes removal of the sole owner impossible; `assertAnotherOwnerRemains` blocks it). Impersonated support sessions are read-only everywhere. Last owner cannot leave/remove self before transferring.
6. **What does the new member see?** Their org appears in the picker with their role badge; every surface renders through the role × entitlement matrix (UI hides, Engine guards enforce). Suspended/removed members lose access **immediately, even mid-session** — the guard resolves role from `active` rows only, per request. First action is guided to something collaborative (reply in a shared conversation, run the team's assistant), not to settings they can't touch.

---

## 1. Invite creation (owner/admin only)

- Entry: members page → email + role picker (`admin | billing | developer | reader` — owner absent by construction; inviting AS admin is owner-only + step-up, `org-members.controller.ts:185-192`) → delivery choice (§1A) → `POST :orgId/invites` (`@Idempotent`, rate-limited, `org-members.controller.ts:175-184`).
- Server guards, in order: role invitable (+ admin-role invite requires owner + fresh MFA proof) → email normalized (lowercase — case-mismatch accept bugs are structurally impossible) → not already an active member → not a SUSPENDED member (409 `member_suspended`: "belongs to a suspended member — reactivate in Members instead"; inviting would otherwise silently reactivate via the `addMember` upsert, bypassing the explicit reactivate path and its audit) → removed/nonexistent addresses proceed → no usable pending invite for (org, email) → pending-invite ceiling (`ORG_MAX_PENDING_INVITES`).
- Pending row shows in the invites tab with computed status (pending/accepted/revoked/expired — never stored, derived per read so it cannot drift).
- Lifecycle ops on pending rows: **resend** (token rotation + attempt reset + TTL restart, cap 5 — rotation-guarded against concurrent redeem), **extend** (expiry push, token unchanged, ≤30d), **revoke** (one write, link dies immediately with the same generic error as expired). All audited (`org.invite_created/resent/extended/revoked`).

## 1A. Delivery methods — URL-first, email retained (locked decision)

Enterprise gateways routinely quarantine external invite mail AFTER accepting SMTP (mailer shows delivered, inbox never fills) — the industry fix is a copy-link path that bypasses our mailer entirely, while keeping per-email binding (NOT open reusable links: open links turn the URL into a bearer credential and need a separate revocation design — explicitly rejected here).

| | Email (backend unchanged) | Manual / copy-link (PRIMARY) |
|---|---|---|
| Admin action | email + role → Done | email + role → success panel |
| Engine does | creates invite + sends `org.invite` email | creates invite, sends NOTHING |
| Response | `{inviteId, email}` (no URL — nothing to leak) | `{inviteId, email, accept_url, expires_at}` — shown ONCE (`expires_at` is non-secret metadata the mailto draft needs for its validity line) |
| Admin shares via | — (already sent) | Copy button + "Compose email" (auto-generated `mailto:` draft, §1B) + forward in Slack/own mailbox |

Engine contract for the later implementation (specified here so it is mechanical):

- `POST :orgId/invites {email, role, delivery?: 'email'|'manual'}` — default `email` = today's behavior byte-for-byte. `manual` skips `sendInviteEmail` and returns `accept_url` one time.
- `POST :orgId/invites/:id/resend {delivery?}` — same rule; manual resend returns the NEW `accept_url` once (old link already dead by rotation).
- List / detail / extend NEVER return URL or token (hash-only storage makes re-display impossible without rotation — this is the technical reason behind show-once; state it in UI copy: "for security this link is shown once — resend to generate a new one").
- Audit rows never contain token/URL (verify: current `details` carry role/TTL only — keep it that way; add a log-grep gate on a known-issued token).
- `accept_url` host is server-built from config (`ENGINE_BASE_URL`, as today in `inviteUrl()`), never from the request `Host` header.
- Rate limits, guards, idempotency: unchanged. Verified: the `@Idempotent` fingerprint is method+path+body-hash (`idempotency.ts:51-53`), so the delivery flag rides it — a retried create with the same key replays the original decision instead of minting a second invite, and switching method with the same key correctly 409s (different body). To switch an already-created invite's method, use Resend with the new flag — a fresh create would hit the pending-duplicate guard, not duplicate.

## 1B. Frontend share UX (no Engine work)

- Success panel (manual only): masked link field with reveal-while-open + **Copy** (clipboard + "copied" confirm) + **Compose email** button opening `mailto:{invitee}?subject=…&body=…` prefilled by the template below + **Done** (masks permanently; panel unmounts, secret leaves memory).
- Auto-generated draft (the "email for them"): subject `You've been invited to {org} as {role}`; body: inviter line (`{actor} invited you…`), what the role can do (one line per §4), link on its own line, expiry line (`valid {N} days`), mismatch warning ("sign in with {email} — other addresses will be rejected"). No PII beyond what the admin typed; link excluded from any telemetry.
- Invite landing page sets `Referrer-Policy: no-referrer` (link in URL must not leak to analytics/embeds).
- Pending-row actions per method: email → Resend (re-emails rotated link) / Revoke / Extend; manual → Resend (returns new shown-once link AND, if delivery flipped to email, sends it) / Revoke / Extend / Copy is NOT re-offered (rotation-only re-access).

## 2. Email path notes (backend unchanged)

- Engine sends the `org.invite` email (inviter name, org name, role, TTL days, accept URL). The link is **possession only, never identity**: it proves nothing until the session email matches at redeem (industry anti-pattern "click-to-provision" is structurally avoided — Engine requires independent OAuth identity first).
- The real security control under BOTH delivery methods is email-binding at accept: a forwarded/screenshotted link is useless without a session for the invited address. Short TTL only bounds the window; binding does the work.
- Operational note for later (not this release): log delivery/bounce status per invite so "never received it" is diagnosable, and use a named sender subdomain with SPF/DKIM/DMARC rather than no-reply. The invite row has no delivery columns today — add only when support tickets demand it. (Manual delivery already sidesteps this entire class.)

## 3. Accept flow (new vs existing user — one path, fork at identity)

```text
GET /platform/invites/:inviteId?token=   ← NEW frontend route (does not exist yet)
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
      ⚠️ IMPLEMENTED as `POST console/org/invites/:inviteId/preview` with
      `{token}` in the JSON BODY — never the query string. Rationale, verified
      in-repo: proxies/CDNs log url+query, and Engine's own Fastify request
      logs record `url` with query string (`logger.ts:8`) outside the redact
      paths (`logger.ts:18-58`, which cover headers and body keys like
      `*.token` but NOT `req.url`). Bodies appear in neither. Returns ONLY
      {org_name, role, expires_at, invited_by (display name, never email),
      email_hint (`j***@acme.com` masked)}.
      Rules: token-hash comparison only; uniform generic error for
      missing/revoked/expired/accepted/locked (same status/body/timing); strict
      IP-scoped rate limit; token never logged, never in audit details;
      `Referrer-Policy: no-referrer` on the page.
      No membership data, no email echo beyond the masked hint.
  → [Accept] → POST …/invites/:inviteId/redeem
  → Engine (invites.service.ts:218-281): hash match → liveness (not revoked/
    accepted/expired, attempts < 5) → session-email == invite-email (403) →
    addMember (seat/member caps checked HERE; refusal keeps invite usable) →
    single-use claim (conditional update — concurrent double-click is safe) →
    audit + OrgInviteAccepted event → returns {orgId, role}
  → set active org = redeem.orgId (never contexts[0]) → role-scoped dashboard
    + "invited by X as {role}" context banner
```

- **New user:** OAuth auto-creates the account (plus its own background personal org — expected, stays in picker). No second OTP/email proof: the OAuth IdP verification IS the identity proof; the invite token only selects the pending grant.
- **Existing user:** no re-registration; membership attaches to the current account. No duplicate account is possible (email is the unique identity).
- **Wrong-email session:** 403 + "invitation was sent to {email} — switch accounts" (account-switch action, stash retained). Never auto-create or auto-link across addresses (takeover-by-unverified-email stays impossible).
- **Expired/revoked/used:** uniform invalid-invite screen + "Continue to my workspace" exit (brand-new users already own a personal org — first-run doc §2 rule).
- **Seat-full:** "workspace is full — ask an owner, invitation stays valid" + retry (invite deliberately unburned).

## 4. Role model and admin powers (the complete matrix)

Roles: `owner | admin | billing | developer | reader` (`ORG_ROLES`). Ownership is singular per org as a **partial unique DB index** (`uq_one_active_owner_per_org`, `drizzle/0044`) — the index enforces the UPPER bound only (never two active owners, even under concurrent transfer); the LOWER bound (≥1 owner) is application-enforced (`assertAnotherOwnerRemains` on remove/leave/demote + `changeRole` transfer rules), deliberately, so the org purge (which deletes all memberships) is never DB-blocked.

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

Enforcement order per request (industry rule, Engine implements): membership → role → ownership/sharing. `getRole` resolves from `active` rows only — suspension/removal is an immediate, session-independent lockout; no "still logged in so still allowed" gap. Support impersonation (`principal.imp`) is read-only on all mutating member/invite routes.

Offboarding posture: **suspend before remove** (suspend keeps the row + history, cheap recovery; remove is the clean exit; both audited with actor + email). Resources are org-owned, so nothing strands on removal; leaver history stays attributable.

## 5. New-member dashboard experience

- Org picker shows the new org with role badge; active org persists via existing `OrgContext` (`neryva.active_org`).
- Role-gated chrome: owners/admins see members/settings/billing; developers see build surfaces; billing sees money surfaces; readers see lists + conversations/runs, no mutating actions. Every hidden control has a server guard behind it (hidden button = UX, never the boundary).
- Guided first collaborative action within the session: open a shared conversation or run the team's published assistant (test-run where safe). Checklist shows team-flavored items (meet the workspace, run the team assistant) rather than setup items the member cannot complete.
- Notifications (all verified in `notifications.service.ts:131-206`): new member gets in-app `org.member_added`; suspended → warn; reactivated → info; removed → warn (never on self-leave); existing accounts get an in-app `org.invite_created` row alongside the email; owners/admins get `org.invite_accepted` feed rows. Role changes send a direct `org.role-changed` email from the memberships flow plus audit `org.member_role_changed`.

## 6. Acceptance criteria (ship gate)

- [ ] Owner/admin invites by email+role+delivery: email path delivers the link with no URL in any response; manual path returns `accept_url` once; token never appears in any other API response, log, or analytics event (grep-proven).
- [ ] New-address invitee: OAuth → accept → member with invite role; no duplicate account; personal background org untouched.
- [ ] Existing user: accept attaches membership; already-member gets "already a member", not a second row (unique `(account, org)`).
- [ ] Wrong-email session → 403 + switch-account path; expired/revoked/used → uniform invalid screen + workspace exit; seat-full → retryable "workspace full" (invite intact); suspended address invited → 409 `member_suspended` + reactivate-instead copy (no silent reactivation).
- [ ] Preview is POST-only (GET → 404); scanner/prefetcher POSTs change no state (replay 10×, invite still pending, attempts untouched); wrong token reveals nothing distinguishable from expired; raw token absent from request logs (grep a preview call's request-id across the log stream).
- [ ] Double-click/refresh/concurrent redeem → exactly one membership (conditional claim + upsert), idempotent replays.
- [ ] Admin cannot assign owner/admin (403 + step-up proof demanded of owner path); cannot remove owner/admin; last owner cannot leave.
- [ ] Suspended member's in-flight session denied on next request (guard re-check, not just UI hide).
- [ ] Audit covers `org.invite_created/resent/extended/revoked/accepted`, `org.member_added/role_changed/suspended/reactivated/removed/left`, ownership transfer — queryable per org, resource IDs present, no raw tokens anywhere.
- [ ] Email normalization proven: invite `Alice@X.com` accepted by `alice@x.com` session.

## 7. Deferred (explicitly not this release)

SCIM provisioning/deprovisioning, domain-claim auto-join, SSO-JIT, guest/restricted-member roles, temporary time-boxed grants, per-resource ACLs, invite-delivery telemetry columns. Each arrives only with an enterprise contract — the role/enforcement skeleton already supports them without migration.

## 8. Engine work-list (IMPLEMENTED 2026-09-15 — was "specified, not yet implemented")

Both landed, additive only (no migration, no semantic change to existing paths):

1. **Delivery flag + one-time URL** (`org-members.controller.ts` DTOs, `invites.service.ts` create/resend). `delivery?: 'email'|'manual'` whitelisted at the DTO boundary and re-validated fail-closed in the service (`normalizeInviteDelivery`). Default `email` = previous behavior byte-for-byte. Manual skips `sendInviteEmail` and returns `{inviteId, email, accept_url, expires_at}` once; resend mirrors it. List/detail/extend/audit untouched and URL-free.
2. **Public invite preview** (`POST console/org/invites/:inviteId/preview`, body `{token}`, `org.controller.ts` + `invites.service.ts` preview). Hash-only lookup, uniform `404 invitation` for every non-usable state (missing/bad-token/revoked/accepted/expired/locked included), no attempt registration, no audit row, IP-scoped `org-invite-preview` rate limit, masked `email_hint` (`maskInviteEmail`: first local char + full domain). POST-not-GET deliberately: proxies/CDNs and Engine's own Fastify request lines log url+query outside the redact paths — bodies appear in neither.
3. **Suspended re-invite rejected at creation** (`create()` 409s `member_suspended` with reactivate-instead copy). No-crash note: the old path could not 500 — the `addMember` upsert would have silently reactivated — but silent reactivation bypasses the explicit path and its audit, so rejection is the correct semantic. Removed/nonexistent addresses proceed as before.

---

## References

- `engine/src/modules/organizations/invites.service.ts:61-99,218-286` — create guards, redeem, single-use claim, invite URL shape
- `engine/src/modules/organizations/org-members.controller.ts:62-184` — list/detail/role/suspend/reactivate/remove/leave/invite routes + guards
- `engine/src/modules/organizations/org.controller.ts` — redeem (`invites/:inviteId/redeem`) + public preview (`POST invites/:inviteId/preview`, body token)
- `engine/src/modules/organizations/memberships.service.ts:43-60,244-337` — exactly-one-owner invariant, addMember seat wall, changeRole transfer rules
- `engine/src/modules/organizations/schema.ts:172-197` — roles, invitable set, staged deletion
- `engine/src/modules/organizations/org-access.service.ts:37-41` — unconditional personal-org autocreation (background org for invitees)
- Research: stateful-pending-grant invite pattern (server grant + claim token + atomic email-bound accept; resend-rotates; preview side-effect free); least-privilege ladders with singular transferable owner; suspend-before-remove; membership→role→ownership check order; acceptance matrix (new/existing/wrong-email/expired/double-click/seat-full/case-mismatch).
