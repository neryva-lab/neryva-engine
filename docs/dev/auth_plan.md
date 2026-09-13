# Auth & Authorization Plan — Neryva Engine

> **Status:** FINAL for execution (2026-09-13). Design authority for the unified user / authorization model.
> **Execution ledger:** `docs/dev/auth_ledger.md` (`AUTH-<phase>.<seq>` task IDs — reference in PR titles).
> **Rule (inherited from `final_ledger.md`):** a task is DONE only with code + test + evidence (CI / DB-gate run).
> Until the first full CI/DB run, completed tasks are `CODE_COMPLETE / GATES_PENDING`, never `DONE`.
> **Rule (mission):** design-doc-first — this document is reviewed before any code lands.

## 1. Purpose & scope

The platform has several user classes — customer org members, Neryva platform staff, machine principals,
and conversational end-users — and needs one coherent, production-grade model for identity, membership,
and authorization. This plan:

- verifies the **current state** of that model in code (§2, every claim anchored),
- fixes the four places where correctness rests on application discipline instead of database guarantees
  (D1, D2, D4, D5),
- builds the two missing product capabilities (D1 staff provisioning, D3 team-org creation),
- and holds the boundaries that are already correct (D6).

Out of scope: enterprise SSO/SCIM connections, custom roles, fine-grained sharing — listed as named future
seams in §9, deliberately not built.

## 2. Verified current state (2026-09-13 — do not re-litigate without a new code pass)

| # | Fact | Anchor |
|---|---|---|
| F1 | One human identity registry `accounts` (platform-plane, no RLS, engine-only writer). Email citext-unique; `password_hash` nullable; `mfa_level`; status `active/locked/disabled`; `created_via` one-way binding (federated-origin accounts never grow a password); `sessions_revoked_at`; staged `deleted_at`. | `src/modules/identity/schema.ts:31` |
| F2 | Passwords have a **single source of truth**: `accounts.password_hash` (written/read only by `password.service.ts:86/126/159`). `account_credentials` is used only for `totp`/`totp_pending` (`mfa.service.ts:53/94`). No dual-write bug — but the table's advertised `kind` set (`password / email_code / totp / webauthn`) is aspirational, and its `unique(account_id, kind)` index structurally forbids multi-credential factors (WebAuthn). | `schema.ts:54,66`, `password.service.ts` |
| F3 | Org roles are resolved **per request from the DB** through `OrgAccessPort.getMembershipRole` — never embedded in tokens. | `src/common/policy/org-roles.guard.ts:56` |
| F4 | Platform staff authorization reads a `platform_role` claim from the L1 JWT (`auth.guard.ts:170`), enforced by `PlatformStaffGuard` + `@StaffRoles(...)` (`staff.guard.ts`). **Nothing in the codebase mints that claim** — `claimsFor` emits only `sub/email/email_verified/name/updated_at` (`accounts.service.ts:111`). No staff table, no grant/revoke path. Only working staff credential: `BOOTSTRAP_API_KEY` break-glass (L2 `super_admin`, `auth.guard.ts:187`). | `auth.guard.ts:170`, `staff.guard.ts:32`, `accounts.service.ts:111` |
| F5 | Exactly-one-owner is **application discipline only**: `assertAnotherOwnerRemains` (`memberships.service.ts:479`); ownership transfer is promote-then-demote with a compensating rollback in app code — `org-lifecycle.service.ts:294` documents it honestly as "atomically enough". Two statements, no transaction; a crash between them can leave two active owners. | `memberships.service.ts:479`, `org-lifecycle.service.ts:290` |
| F6 | The only org-creation path is the personal-org autocreation on signup (ADR-001): `AccountCreated` event → `createPersonalOrg` INSERTs the Python-owned `tenants` row (documented seam: engine inserts, Python owns DDL until handover A-1) + `owner` membership, slug `pers-<email>-<8hex>` with collision retry. **No "create team/workspace" endpoint exists** (searched all controllers). | `org-access.service.ts:50` |
| F7 | Membership lifecycle is invite-only (Δ3) and robust: sha256 tokens, single-use, attempt-capped, one usable invite per (org,email), pending ceiling, capacity cap `assertCapacity` ("abuse posture, not billing"). Role change / suspend / reactivate / remove / leave / transfer all exist with owner-preservation checks. | `invites.service.ts`, `memberships.service.ts:256`, `org-members.controller.ts` |
| F8 | `product_entitlements.seats` is **reported** (utilization, `memberships.service.ts:209`) but **not enforced** at invite/redeem — the only gate is the abuse cap. | `memberships.service.ts:209,255` |
| F9 | Conversational end-users are `conversation_participants` (`participant_type = account | service | channel`, `external_ref` for channel senders) — **not** accounts. Correct boundary. | `src/modules/conversations/schema.ts:39` |
| F10 | Account deletion is a tombstoned state machine: staged `deleted_at` → cancel window → purge (idempotent delete by id; email becomes reusable only after purge). | `account-deletion.service.ts:77`, `account-purge.worker.ts` |

## 3. Design principles (the five patterns this plan holds)

1. **Identity ≠ Authorization.** `accounts` answers "who authenticated"; everything about "what may they
   do" lives in binding rows at the edges. Customers and Neryva staff deliberately share the one registry
   (Okta/Auth0/Google pattern); staff are users with a staff *binding*, not a different species of row.
2. **The database is the authority; tokens are caches.** Org roles resolve per request from
   `org_memberships` (F3). Platform staff resolve the same way (D1). No authorization ever syncs into JWTs.
3. **Invariants are enforced by the database, not by hope.** Application checks remain as
   defense-in-depth and for error translation, but the schema is the backstop (D2).
4. **Delegated administration.** Org owners/admins run their own membership lifecycle (F7) without platform
   involvement. Platform staff are a separate axis with strictly harder controls (step-up, audit, JIT expiry).
5. **Lifecycle as tombstoned state machines.** Nothing is destroyed in place; deletion is staged, cancelable,
   purgeable, and auditable (F10).

### Explicitly rejected (do not relitigate in review)

Role columns on `accounts` · a `staff` boolean · org IDs inside JWTs · per-role tables · a custom-roles
engine in v1 (fixed role set + tested permission matrix is the right scale; custom roles are an enterprise
v3 feature) · ReBAC/Zanzibar-style authz (no concrete sharing requirement exists) · merging platform RBAC
into org RBAC · syncing authorization into tokens · admitting conversational end-users into `accounts`.

## 4. Target model

| Layer | Table(s) | Authority for |
|---|---|---|
| Identity | `accounts` + `account_credentials` + `account_recovery_codes` + `account_identities` + `email_login_codes` + `account_action_tokens` | who authenticated; all authn factors |
| Org binding | `org_memberships` (+ `org_invites`, `org_groups*`) | org roles `owner/admin/billing/developer/reader` |
| Platform binding | `platform_staff` (**new**, D1) | staff roles `super_admin/tenant_admin/operator/auditor` |
| Machine principals | `nrv_live_` keys (Python-owned), `org_service_accounts` (`nrv_sa_`), L3 `svc-` clients | scoped machine access |
| Conversational end-users | `conversation_participants` / channel senders | ephemeral, conversation-bound (D6) |
| Orgs | Python-owned `tenants` (INSERT seam) + engine-owned `org_settings.kind` (**new** column, D3) | workspace records |

## 5. Deltas

### D1 — Platform staff subsystem — BUILD (P0, security-critical)

**Problem.** F4: the staff axis has a guard but no authority — no table, no mint, no grant/revoke. The only
staff credential is the break-glass key.

**Decision (final).**
- New engine-owned platform-plane table (no RLS — same posture as `accounts`; every transition audited):

```sql
create table platform_staff (
  account_id   uuid primary key references accounts(id) on delete cascade,
  role         varchar(16) not null check (role in ('super_admin','tenant_admin','operator','auditor')),
  granted_by   uuid not null,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz,            -- null = standing grant; set = JIT access
  revoked_at   timestamptz,
  revoke_reason varchar(512)
);
create index ix_platform_staff_role on platform_staff (role) where revoked_at is null;
```

- Resolution follows the established optional-port pattern (`SESSION_REGISTRY_PORT`): a new
  `PlatformStaffDirectoryPort` in `common/auth/ports.ts`, implemented by the staff module
  (`PlatformStaffDirectoryService`), registered in `AppModule` after feature modules — **fail closed when
  the module is disabled** (same posture as the unbound session registry).
- `PlatformStaffGuard` consults the port per request for L1 principals (60s Redis cache
  `auth:staff:{accountId}`; revoke/expiry clears the key). **The table is the authority; the JWT claim is an
  optimization.** Revocation therefore takes effect on the next request, not at token expiry. The existing
  claim read (`auth.guard.ts:170`) stays for backward compatibility of the principal shape but the guard no
  longer trusts it alone. L2 key role (legacy `api_keys.role`) is unchanged.
- **No token minting changes in v1.** `claimsFor` stays as verified (F4); the OP emits no `platform_role`
  until a UI needs it, at which point it is minted at the OP boundary from the table (extra-token-claims
  hook — exact hook verified at implementation time). Staff console reads `GET /internal/staff/roles/me`.
- Management surface under `internal/staff` (existing controller), `@StaffRoles('super_admin')` + step-up:
  `POST /internal/staff/roles` (grant: account_id, role, expires_at?), `DELETE /internal/staff/roles/:accountId`
  (revoke + reason), `GET /internal/staff/roles` (list), `GET /internal/staff/roles/me`.
  Audit actions: `staff.role_granted`, `staff.role_revoked` (actor, target, role, reason, expiry, trace id).
- **Cold start:** optional env `PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS` (comma-separated emails) upserted to
  `super_admin` on module init, audited; empty in production config unless ops explicitly sets it.
- Break-glass `BOOTSTRAP_API_KEY` is unchanged and stays documented as the disaster path.

**Files.** `drizzle/0043_platform_staff.sql` (+journal, ownership-map) · `common/auth/ports.ts` ·
`modules/staff/platform-staff.schema.ts` · `modules/staff/platform-staff.directory.ts` ·
`modules/staff/staff.controller.ts` · `common/policy/staff.guard.ts` · `app.module.ts` (port registration) ·
`common/config/env.ts` (`PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS`).

**Gates.** Typecheck/build/lint zero errors · `MIG` · negative tests authored (revoked staff denied on the
next request; expired JIT grant denied; port-unbound = deny; cache cleared on revoke) · `SEC` (no PII in
audit details beyond ids/reasons).

### D2 — Exactly-one-owner as a database invariant — FIX (P0, security-critical)

**Problem.** F5: owner preservation and ownership transfer rely on app-level checks; the transfer is two
statements without a transaction, and a crash between them can leave two active owners.

**Decision (final).** Syntax constraint first (verified against the PostgreSQL `CREATE INDEX` grammar):
`DEFERRABLE` exists **only** on table constraints, and a table `UNIQUE` constraint cannot carry a `WHERE`
(partial) predicate — so "deferred + partial" cannot be expressed as one DDL object. Deferrability is also
**unnecessary**: a plain partial unique index enforces the invariant that matters at every statement
boundary, provided the transfer orders its statements demote-then-promote.

```sql
create unique index uq_one_active_owner_per_org
  on org_memberships (org_id) where role = 'owner' and status = 'active';
```

- **Invariant scope:** the DB enforces **at most one** active owner — the corruption that matters (two
  owners). The lower bound (≥1) stays application-level (`assertAnotherOwnerRemains` etc.) because the org
  purge legitimately deletes **all** memberships of an org (`org-lifecycle.service.ts` `purge`) and must
  never be blocked at the database.
- Pre-flight in the migration: abort with a clear message if any org currently has **more than one** active
  owner (index would be invalid); report (not block) orgs with zero active owners as a data-quality finding.
- `OrgLifecycleService.transferOwnership` becomes one `withOrg` transaction performing **demote-then-promote**
  as two direct UPDATEs (not via `changeRole` — its owner-preservation check would trip mid-transfer before
  the promote lands), with a post-condition `count(active owners) = 1` before COMMIT; the compensating-
  rollback block is deleted. A crash between the statements rolls the whole TX back — no two-owner window
  exists at any instant. Concurrent transfers serialize on the unique index: the second promote gets `23505`.
- `MembershipsService.changeRole`/`removeMember`/`leaveOrg` keep their app-level lower-bound checks and
  additionally translate the Postgres `23505` unique violation into `ApiError.conflict` with a stable,
  documented code (`owner_already_present`).
- **Rejected alternative (recorded):** a deferred constraint trigger enforcing *exactly one* active owner at
  COMMIT. Rejected because the exactly-one lower bound breaks the org purge (all memberships deleted ⇒ count
  0 ⇒ commit exception ⇒ purge can never complete) unless it carries a purge exemption; it is heavier and
  adds no guarantee over the index for the upper bound. If a future requirement demands the lower bound at
  the DB, add the trigger with an explicit, audited purge-path exemption — not now.

**Files.** `drizzle/0044_org_owner_invariant.sql` (+journal, ownership-map) ·
`modules/organizations/org-lifecycle.service.ts` · `modules/organizations/memberships.service.ts`.

**Gates.** `MIG` · negative tests authored (DB rejects second active owner; concurrent transfer race leaves
exactly one owner; single-TX transfer survives a simulated mid-transaction failure without two-owner state)
· `EXPLAIN` unchanged (index is partial, write-path only).

### D3 — Team-org creation — BUILD (P1, product unlock)

**Problem.** F6: every signup gets a personal org and nothing else; a customer cannot form a company
workspace.

**Decision (final).**
- `POST /v1/orgs` on the L1 console surface (`org.controller.ts`), body `{ name: string (1..128),
  slug?: string }`; `@Idempotent()` + `@RateLimit` + `OrgRolesGuard`-free (no org context yet).
- Same connection discipline as `createPersonalOrg` (F6): INSERT into Python-owned `tenants` (documented
  seam) + `owner` `org_memberships` row + eager `org_settings` row with `kind='team'` — all in **one
  transaction**; audited `org.created` with `details.kind='team'`; `EngineEvents.OrgCreated` emitted
  (constant added to the event bus if absent).
- Slug policy: user-supplied or derived from name; `^[a-z0-9][a-z0-9-]{1,62}$`, trailing-hyphen forbidden,
  **reserved-word list** (`www api admin app console neryva support mail staff root billing dashboard …`
  — finalized in code as a constant with a test), collision → `409 conflict` (user-chosen slugs are
  immutable; personal `pers-*` slugs keep the retry loop).
- **Ownership capacity cap** (abuse posture): an account may own at most `ORGS__MAX_OWNED_PER_ACCOUNT`
  (env, default 20) orgs with an active owner membership; enforced at create, audited on block.
- New team orgs start with no entitlements; the owner proceeds through the existing `StartTrial` flow
  (`org.controller.ts` `POST :orgId/entitlements/:product/trial`). The org picker (`listContexts`) picks
  team orgs up automatically via memberships.
- Personal-org autocreation (ADR-001) unchanged.

**Files.** `drizzle/0045_org_kind.sql` (`org_settings.kind varchar(16) not null default 'personal'`,
+journal, ownership-map) · `modules/organizations/org.controller.ts` ·
`modules/organizations/org-access.service.ts` (extract shared `insertOrgWithOwner`) ·
`modules/organizations/org.controller.ts` DTOs · `common/config/env.ts`.

**Gates.** Typecheck/build/lint zero errors · `MIG` · `RLS+` (org_memberships writes under the new flow
respect tenant context; cross-tenant denial negatives) · negative tests (reserved slug, duplicate slug,
ownership cap, non-L1 caller) · idempotent retry replays the same org id.

### D4 — Credential-source consolidation — FIX (P1, expand/contract)

**Problem.** F2: passwords live in `accounts.password_hash` while `account_credentials` claims the factor
registry but is TOTP-only; its `unique(account_id, kind)` index structurally forbids WebAuthn's
multiple-credentials-per-account model. Single source of truth today — a modeling inconsistency that bites
at WebAuthn, not a corruption.

**Decision (final).** Consolidate all factors into `account_credentials`; `accounts.mfa_level` stays as a
**derived cache with a single writer** (`mfa.service.ts` — already the only writer, verified).

- **Expand (0046):** add `credential_id varchar(255)` (nullable — NULL for password/TOTP rows, the passkey
  id for WebAuthn rows); drop `uq_account_credentials_account_kind`; add
  `unique (account_id, kind) where kind <> 'webauthn'` + `unique (credential_id) where credential_id is not
  null`; backfill `kind='password'` rows from `accounts.password_hash` (argon2id `secret`, `verified_at` from
  `accounts` evidence where derivable — rows are written even where provenance is unknown, flagged in the
  migration notes). `password.service.ts` switches reads/writes to the table (verify against
  `kind='password' and revoked_at is null`; change-password = update row + `last_used_at`).
  Rejected alternative: a single composite `unique (account_id, kind, credential_id)` — for password rows
  `credential_id` is NULL and PostgreSQL treats NULLs as distinct, so multiple password rows would silently
  not conflict (fixing that requires PG15+ `NULLS NOT DISTINCT`); the partial-unique shape enforces the same
  invariants on every supported PG version.
- **Dual-read window:** one release where `password.service` reads the table and falls back to
  `accounts.password_hash` on missing row (rollback safety), then flips to table-only.
- **Contract (0047, separate release-gated migration):** drop `accounts.password_hash`.
  Rollback plan: forward-fix only (re-adding the column would resurrect dual truth); documented as
  destructive with the expand/contract note in the PR.

**Files.** `drizzle/0046_credentials_expand.sql`, `drizzle/0047_credentials_contract.sql` (+journal,
ownership-map deltas) · `modules/identity/password.service.ts` · `modules/identity/accounts.service.ts`
(factor status reads).

**Gates.** `MIG` (expand/contract notes) · negative tests (password verify after backfill; passwordless
account `created_via='social:*'` never gains a password row without an explicit set-password flow — Δ1
one-way binding preserved) · `SEC` (no hash material in logs).

### D5 — Seat enforcement at redeem — DECIDE + GATE (P1)

**Decision (final): codify the seat wall at invite redemption.**

- Rule: count **active** human memberships per org (`org_memberships.status='active'`, service accounts
  excluded — they are not seats). If the org has an entitlement row (any product) with `seats is not null`
  and `status in ('trial','active','past_due')` and activeMembers ≥ seats → redeem rejected with
  `ApiError` HTTP `402` code `seat_limit_reached`, message pointing at the billing surface. Orgs without a
  seat-based entitlement are uncapped (trial/self-serve posture; the abuse cap F7 still applies).
- **Pessimistic lock (concurrency requirement):** the count-then-insert check runs inside the redemption
  transaction **after** `SELECT … FROM product_entitlements WHERE org_id = $1 AND seats IS NOT NULL
  FOR UPDATE`. Without the row lock, two invites redeemed in the same instant both read
  `activeMembers < seats` under READ COMMITTED and both insert — the seat wall is bypassed. Locking the
  seat-bearing entitlement row serializes all redemptions for that org; orgs without such a row are exactly
  the orgs with no cap, so the lock's absence there is moot.
- Invite **creation stays allowed** (admins pre-plan; utilization already surfaced in `summary`,
  `memberships.service.ts:209`) — enforcement happens exactly once, at the moment membership is granted
  (`invites.redeem` → `memberships.addMember`, and any direct `addMember` path).
- Removal/suspension releases the seat immediately (activeMembers counts `status='active'` only).
- Dev/test override flag `ENTITLEMENTS__SEAT_ENFORCEMENT` (default on) so integration suites can exercise
  both postures without Stripe fixtures.
- Billing keeps sole write authority on `seats` (unchanged).

**Files.** `modules/organizations/memberships.service.ts` (seat check in `addMember`) ·
`modules/organizations/invites.service.ts` (redeem error mapping) · `common/config/env.ts`.

**Gates.** Negative tests authored (at-limit redeem blocked with stable code; removal frees the seat;
service accounts and owner consume no seat; seat-less entitlement uncapped) · unit tests for the counting
query.

### D6 — End-user identity boundary — HOLD + RECORD (P2)

**Decision (final, mandate): conversational end-users stay out of `accounts`** — they are
`conversation_participants` (`account | service | channel`, `external_ref` for channel senders, F9). The
credential store is for principals that authenticate to the control plane — this is an isolation mandate,
not a convention: no FK from participant surfaces into `accounts`, no auto-provisioning of accounts from
channel/widget identities, and no reuse of `accounts` rows as end-user profiles. If a consumer-facing
account product ever becomes real, that is a new audience dimension on the registry designed at that time —
never a gradual blurring.

**Deliverable.** One ADR (`docs/architecture/engine/decisions/`) recording the boundary, the rejected
alternatives (§3), and the future-seam list (§9), cross-linked from this plan and the ledger.

## 6. Sequencing

| Order | Work | Why this order |
|---|---|---|
| 1 | D1 (AUTH-1.1…1.4) | The staff axis is the open security gap; everything else is hardening |
| 2 | D2 (AUTH-1.5…1.6) | Same migration wave as D1; DB invariant lands before new write paths (D3) multiply |
| 3 | D3 (AUTH-2.x) | Product unlock; benefits from D2's invariant on its owner-membership write |
| 4 | D4 (AUTH-3.x) | Hygiene with a release-gated contract step; independent of D1–D3 |
| 5 | D5 (AUTH-4.1) | Small gate after D3 (seat counting includes team-org members) |
| 6 | D6 (AUTH-5.x) | Documentation, lands last so it references the final model |

Each task = one PR, `AUTH-x.y` in title and description, per the PR hygiene rules in `AGENTS.md`.

## 7. Migration & ownership-map notes

- Planned migrations (final numbers assigned at implementation; next free index after `0042`):
  `0043_platform_staff` (D1) · `0044_org_owner_invariant` (D2) · `0045_org_kind` (D3) ·
  `0046_credentials_expand` + `0047_credentials_contract` (D4, contract is release-gated). D5 needs no DDL.
- Every migration: `drizzle/meta/_journal.json` bump + `ownership-map.json` delta (`engine-ts`) + review of
  the SQL (the 0044 partial index is hand-written for review clarity; note `DEFERRABLE` is not expressible
  on `CREATE INDEX` — see D2 for why deferrability is not needed).
- `platform_staff` is platform-plane (no RLS, engine-only writer) — the documented `accounts` posture, not a
  tenant table; it therefore does not join the `RLS+` gate, but its negative tests are listed under D1.
- New engine-owned column `org_settings.kind`; no Python-owned DDL is touched (tenants INSERT seam only).

## 8. Security notes

- All staff-role transitions audited (`staff.role_granted/revoked`) with actor, target, reason, trace id —
  same discipline as every privileged decision (`AGENTS.md` Security).
- Fail-closed everywhere: staff directory unbound ⇒ deny; cache is an optimization, never the authority.
- JIT (`expires_at`) is the default recommendation for operator grants; standing `super_admin` grants
  require explicit justification in the audit record.
- No secrets, tokens, or credential material in logs or audit details; argon2id hashes stay in
  `account_credentials` only.
- Step-up (recent auth) is required on grant/revoke and on team-org creation, matching the existing
  owner-action posture in `org-lifecycle.controller.ts`.

## 9. Non-goals / named future seams (recorded, not built)

Enterprise SSO per org (SAML/OIDC connection bound to `tenants`) · SCIM directory sync (invite automation +
deprovisioning) · domain claim + auto-join / SSO routing · custom org roles · fine-grained sharing / ReBAC ·
per-project role bindings · consumer end-user accounts (audience dimension on `accounts`).

## 10. Verification gates (summary)

Standard gates from `AGENTS.md` apply to every task: typecheck/build/lint zero errors; `MIG` with journal +
ownership-map; tests accompany code (unit + negative for new enforcement points); no test suite is executed
by the implementer — DB-backed exit gates join the first full CI/DB run (`compose up + migrate +
integration/isolation suites`), after which tasks may move `CODE_COMPLETE / GATES_PENDING → DONE`.

## 11. Implementation record (2026-09-13 — all AUTH tasks CODE_COMPLETE)

Gates: typecheck 0 · build 0 · lint 0 errors (33 pre-existing warnings, zero new). Evidence per task in
`auth_ledger.md`. Four grounded deviations from the text above, each recorded here and in the ledger:

1. **D1 — kernel-level directory (AUTH-1.2).** `PlatformStaffGuard` is hosted by four modules (staff,
   satellites ×2 controllers, billing price-catalog); a staff-module port binding would have failed closed
   for L1 staff on satellites/billing surfaces. The resolver (`common/auth/platform-staff.directory.ts`,
   db + redis only) and its schema (`common/auth/platform-staff.schema.ts`, the `idempotency_records`
   precedent) are kernel-level; the port is bound in the global KernelModule (locked-list addition
   justified in ADR-014). Grant/revoke/list/bootstrap stay in the staff module.
2. **D3 — route + no step-up (AUTH-2.2).** The route landed as `POST /console/org` (the existing L1
   console surface convention, not the plan's `/v1/orgs` placeholder). Creation is NOT step-up-gated:
   step-up proofs hard-require an MFA challenge and workspace creation is routine self-serve on every
   major platform — the abuse controls are the rate limit, idempotency, and the ownership cap.
   `createPersonalOrg` moved onto the same single-transaction `insertOrgWithOwner`, closing the
   orphan-tenants window the old two-write path had.
3. **D4 — release-window collapse (AUTH-3.3).** The one-release dual-read window protects deployed data;
   this repository is pre-first-deploy (a single release job applies 0001–0047), so 0046 (expand) and 0047
   (contract) land in the same ordered sequence with the table-only code. Documented in the 0047 header:
   if 0046 is ever applied to a deployed environment, hold 0047 for one release cycle.
4. **D2/D4 refinements carried from review.** The 0044 index is a plain partial unique index (no
   `DEFERRABLE` — invalid on `CREATE INDEX`; demote-then-promote makes it unnecessary); the factor-registry
   uniqueness is two partial unique indexes (a composite `UNIQUE(account_id, kind, credential_id)` would
   lose password uniqueness to NULL-distinctness). One consequential catch from implementation: drizzle
   conflict-target inference against a partial index requires an explicit `targetWhere` — added to the
   password upsert AND the pre-existing TOTP upsert in `mfa.service.ts`, which would otherwise have failed
   at runtime after 0046.
