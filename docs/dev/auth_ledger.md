# Auth & Authorization Ledger — Neryva Engine

> **Status:** FINAL for execution (2026-09-13). Companion to `docs/dev/auth_plan.md` (design authority —
> read before any AUTH task). Independent of `final_ledger.md` (harness work) and `imp/ledger.md`
> (engine phases 0–10); PR titles reference `AUTH-<phase>.<seq>`.
> **Rule (inherited):** a task is DONE only with code + test + evidence (CI / conformance / DB-gate run).
> DB-backed gates join the first full CI/DB run (`compose up + migrate + integration/isolation suites`) —
> until that run happens, completed tasks are marked `CODE_COMPLETE / GATES_PENDING`, never `DONE`.
> **Rule (mission):** no test suites are executed by the implementer; required gates are
> `pnpm run typecheck` / `build` / `lint` at zero errors, migrations with `_journal.json` +
> `ownership-map.json`, and tests *authored* alongside the code.

## How to read this ledger

- **ID** `AUTH-<phase>.<seq>` — stable; reference in PR titles (one task per PR).
- **Status vocabulary:** `TODO` (not started) · `CODE_COMPLETE` (code landed, gates pending) ·
  `GATES_PENDING` (awaiting the CI/DB run) · `DONE` (evidence in).
- **Priority:** `P0` security-critical / blocks safe operation · `P1` immediately after · `P2` docs/guardrails.
- **Exit-gate legend:** `MIG` = reviewed ordered migration + `ownership-map.json` delta + journal bump ·
  `RLS+` = tenant-isolation negative tests for touched tenant surfaces · `NEG` = negative/enforcement tests
  authored · `SEC` = no secrets/credential material in logs/audit details · `EXPLAIN` = plans for new
  list/lookup queries (none expected in this ledger) · `E2E` = scripted end-to-end path.

---

## Phase AUTH-1 — Authority & invariants (D1 + D2, P0 security-critical)

### AUTH-1.1 `platform_staff` table — `CODE_COMPLETE` · P0 · Engine
- **Scope:** new engine-owned platform-plane table (no RLS, `accounts` posture): `account_id` PK → `accounts`
  (cascade), `role` check `('super_admin','tenant_admin','operator','auditor')`, `granted_by`, `granted_at`,
  `expires_at` (JIT), `revoked_at`, `revoke_reason`; partial index on unrevoked rows by role.
- **Deliverables:** `drizzle/0043_platform_staff.sql` + `drizzle/meta/_journal.json` bump +
  `ownership-map.json` entry; drizzle schema file `src/modules/staff/platform-staff.schema.ts`.
- **Depends:** none. **Gate:** `MIG` · `SEC`.

### AUTH-1.2 Staff directory port + resolution service — `CODE_COMPLETE` · P0 · Engine
- **Scope:** `PlatformStaffDirectoryPort` in `common/auth/ports.ts` (`resolve(accountId) → { role, expiresAt } | null`);
  implemented by `PlatformStaffDirectoryService` (staff module) over `platform_staff` (unrevoked, unexpired wins
  by grant recency); registered in `AppModule` after feature modules — **fail closed when unbound**.
- **Deliverables:** port + service + registration; 60s Redis cache `auth:staff:{accountId}` with explicit
  invalidation on revoke/expiry; cache is an optimization, never the authority.
- **Depends:** AUTH-1.1. **Gate:** `NEG` (revoked ⇒ next request denied; expired JIT ⇒ denied; port unbound ⇒ denied)
  · `SEC`.

### AUTH-1.3 Guard rewiring + bootstrap seeding — `CODE_COMPLETE` · P0 · Engine
- **Scope:** `PlatformStaffGuard` consults the directory port for L1 principals (claim read retained for the
  principal shape only, never authoritative); L2 key-role path unchanged; break-glass `BOOTSTRAP_API_KEY`
  unchanged. Env `PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS` (comma-separated emails) upserted to `super_admin` on
  module init, audited, empty-by-default in production.
- **Deliverables:** `common/policy/staff.guard.ts` · `modules/staff/staff.module.ts` seeding ·
  `common/config/env.ts` · audit actions `staff.role_granted` / `staff.role_revoked` reserved.
- **Depends:** AUTH-1.2. **Gate:** `NEG` (non-staff account denied on `internal/staff/*`; deny-by-default when
  no `@StaffRoles` declared) · `SEC`.

### AUTH-1.4 Staff-role management surface — `CODE_COMPLETE` · P0 · Engine
- **Scope:** under `internal/staff`, `@StaffRoles('super_admin')` + step-up: `POST /roles` (grant:
  account_id, role, expires_at?), `DELETE /roles/:accountId` (revoke + reason), `GET /roles`,
  `GET /roles/me`. Every transition audited (actor, target, role, reason, expiry, trace id).
  Cannot revoke yourself if you are the last active `super_admin`.
- **Deliverables:** controller routes + DTOs + service methods + audit records; rate limits per existing
  staff-route discipline.
- **Depends:** AUTH-1.3. **Gate:** `NEG` (non-super_admin blocked incl. other staff roles; self-revoke of last
  super_admin blocked; grant of invalid role rejected) · `SEC`.

### AUTH-1.5 At-most-one-active-owner DB invariant — `CODE_COMPLETE` · P0 · Engine
- **Scope:** partial unique index (hand-written SQL for review clarity): `create unique index
  uq_one_active_owner_per_org on org_memberships (org_id) where role = 'owner' and status = 'active';` —
  enforces **at most one** active owner at every statement boundary; no `DEFERRABLE` (not valid on
  `CREATE INDEX` per the PostgreSQL grammar, and unnecessary with demote-first transfer ordering — see
  `auth_plan.md` §D2). Lower bound (≥1 owner) stays application-level: the org purge deletes all
  memberships and must never be DB-blocked. Pre-flight in-migration: abort if any org has >1 active owner;
  report zero-owner orgs as a data-quality finding without blocking.
- **Deliverables:** `drizzle/0044_org_owner_invariant.sql` + journal + ownership-map.
- **Depends:** none. **Gate:** `MIG` · `NEG` (DB rejects second active owner at the promote statement with
  `23505`; concurrent transfer race leaves exactly one owner; org purge deletes all memberships without
  constraint violation).

### AUTH-1.6 Single-transaction ownership transfer — `CODE_COMPLETE` · P0 · Engine
- **Scope:** `OrgLifecycleService.transferOwnership` becomes one `withOrg` transaction performing
  **demote-then-promote** as two direct UPDATEs (not via `changeRole` — its owner-preservation check would
  trip mid-transfer), with a post-condition `count(active owners) = 1` before COMMIT; delete the
  compensating-rollback block. `MembershipsService.changeRole` / `removeMember` / `leaveOrg` keep their
  app-level lower-bound checks and translate PG `23505` (raised by the unique index at the promote
  statement) into `ApiError.conflict` with the stable code `owner_already_present`.
- **Depends:** AUTH-1.5. **Gate:** `NEG` (mid-transaction failure rolls back to exactly one owner — no
  two-owner window at any instant; demote-to-zero-owners via changeRole/remove/leave blocked with stable
  codes).

---

## Phase AUTH-2 — Team-org creation (D3, P1)

### AUTH-2.1 Org kind column — `CODE_COMPLETE` · P1 · Engine
- **Scope:** `org_settings.kind varchar(16) not null default 'personal'` (check `('personal','team')`);
  `org_settings` row inserted eagerly at team-org creation; personal orgs keep lazy settings (NULL row ⇒
  `personal` semantics).
- **Deliverables:** `drizzle/0045_org_kind.sql` + journal + ownership-map; schema.ts column.
- **Depends:** AUTH-1.5 (owner-membership write protected by the invariant). **Gate:** `MIG`.

### AUTH-2.2 `POST /v1/orgs` — create team workspace — `CODE_COMPLETE` · P1 · Engine
- **Scope:** L1 console surface: body `{ name 1..128, slug? }`; `@Idempotent()` + `@RateLimit`; one
  transaction inserting the Python-owned `tenants` row (documented INSERT seam — same connection discipline
  as `createPersonalOrg`) + `owner` membership + `org_settings{kind:'team'}`; audited `org.created`
  (`kind:'team'`); `EngineEvents.OrgCreated` emitted (constant added if absent). Slug policy:
  `^[a-z0-9][a-z0-9-]{1,62}$`, no trailing hyphen, reserved-word constant + test, user-chosen slug immutable,
  duplicate → `409 conflict`. Ownership capacity cap `ORGS__MAX_OWNED_PER_ACCOUNT` (env, default 20), audited
  on block. Extract shared `insertOrgWithOwner` from `createPersonalOrg`. Personal-org autocreation (ADR-001)
  unchanged; new orgs start with no entitlements (existing `StartTrial` flow follows).
- **Depends:** AUTH-2.1. **Gate:** `NEG` (reserved slug; duplicate slug; ownership cap; non-L1 caller) ·
  `RLS+` (membership write under tenant context; cross-tenant denial) · idempotent retry replays the same org id.

---

## Phase AUTH-3 — Credential consolidation (D4, P1, expand/contract)

### AUTH-3.1 Factor-registry expand — `CODE_COMPLETE` · P1 · Engine
- **Scope:** add `credential_id varchar(255)` (nullable; passkey id for WebAuthn rows, NULL for
  password/TOTP); replace `uq_account_credentials_account_kind` with `unique (account_id, kind) where kind
  <> 'webauthn'` + `unique (credential_id) where credential_id is not null` (partial-unique shape is
  version-independent — the composite `unique(account_id, kind, credential_id)` alternative loses password
  uniqueness to NULL-distinctness unless PG15+ `NULLS NOT DISTINCT`); backfill `kind='password'` rows from
  `accounts.password_hash` (argon2id `secret`; provenance flagged in migration notes where undeterminable).
  WebAuthn-ready shape.
- **Deliverables:** `drizzle/0046_credentials_expand.sql` + journal + ownership-map.
- **Depends:** none. **Gate:** `MIG` (expand notes) · `NEG` (multiple webauthn rows per account allowed;
  second password row rejected).

### AUTH-3.2 Password service switch (dual-read window) — `CODE_COMPLETE` · P1 · Engine
- **Scope:** `password.service.ts` reads/writes `account_credentials` (`kind='password'`, `revoked_at is
  null`); change-password updates the row + `last_used_at`; one-release fallback read to
  `accounts.password_hash` for rows the backfill missed; Δ1 one-way binding preserved (`created_via='social:*'`
  never gains a password row without the explicit set-password flow).
- **Depends:** AUTH-3.1. **Gate:** `NEG` (verify/change after backfill; passwordless account stays
  passwordless) · `SEC` (no hash material in logs).

### AUTH-3.3 Contract: drop `accounts.password_hash` — `CODE_COMPLETE` · P1 · Engine (release-gated)
- **Scope:** `drizzle/0047_credentials_contract.sql` drops the column after the dual-read window closes;
  forward-fix only (rollback = re-expanding the table, documented as destructive with expand/contract note);
  `accounts.service.ts` factor-status reads updated.
- **Depends:** AUTH-3.2 + one release cycle. **Gate:** `MIG` (contract/rollback notes) · `NEG` (auth flow
  unaffected post-drop).

---

## Phase AUTH-4 — Seat enforcement (D5, P1)

### AUTH-4.1 Seat gate at invite redemption — `CODE_COMPLETE` · P1 · Engine
- **Scope:** rule per `auth_plan.md` §D5: count active human memberships (`status='active'`, service
  accounts excluded); if the org holds an entitlement (`status in ('trial','active','past_due')`) with
  `seats is not null` and activeMembers ≥ seats → redeem rejected HTTP `402`, stable code
  `seat_limit_reached`, billing-surface pointer; seat-less entitlements uncapped; abuse cap unchanged;
  removal/suspension frees the seat; invite creation stays allowed (utilization already surfaced in
  `summary`); enforcement lives in `MembershipsService.addMember` (covers every membership-granting path);
  flag `ENTITLEMENTS__SEAT_ENFORCEMENT` (default on) for test postures; billing keeps sole write authority
  on `seats`.
- **Pessimistic lock:** the count-then-insert check runs inside the redemption transaction after
  `SELECT … FROM product_entitlements WHERE org_id = $1 AND seats IS NOT NULL FOR UPDATE` — without the
  row lock, two concurrent redemptions both read `activeMembers < seats` under READ COMMITTED and both
  insert, bypassing the wall. Only seat-bearing rows are locked; orgs without one have no cap to bypass.
- **Depends:** AUTH-2.2 (counting includes team-org members). **Gate:** `NEG` (at-limit redeem blocked with
  stable code; concurrent redemption race cannot oversubscribe — both park on the lock; removal frees the
  seat; owner/service accounts consume no seat; seat-less entitlement uncapped) · unit tests for the
  counting query.

---

## Phase AUTH-5 — Boundary record (D6, P2)

### AUTH-5.1 End-user identity boundary ADR — `CODE_COMPLETE` · P2 · Engine
- **Scope:** ADR in `docs/architecture/engine/decisions/` recording, as an **isolation mandate** (F9 anchor):
  conversational end-users stay in `conversation_participants` (`account | service | channel`,
  `external_ref`), never `accounts` — no FK from participant surfaces into `accounts`, no auto-provisioning
  of accounts from channel/widget identities, no reuse of `accounts` rows as end-user profiles; plus the
  five design principles, the explicitly-rejected list, and the future-seam list (SSO/SCIM/domain claim/
  custom roles/ReBAC/project bindings/consumer accounts). Cross-link `auth_plan.md`, `auth_ledger.md`,
  `AGENTS.md`.
- **Depends:** AUTH-1…4 statuses decided (content references final model). **Gate:** docs review.

### AUTH-5.2 AGENTS.md + plan cross-sync — `CODE_COMPLETE` · P2 · Engine
- **Scope:** AGENTS.md gains a two-line pointer to `auth_plan.md` / `auth_ledger.md` in the identity/
  organizations context (kept under the 500-line budget); ledger statuses reconciled.
- **Depends:** AUTH-5.1. **Gate:** docs review.

---

## Status tally (update in the same PR that changes any status)

| Phase | TODO | CODE_COMPLETE | GATES_PENDING | DONE |
|---|---|---|---|---|
| AUTH-1 | 0 | 6 | 0 | 0 |
| AUTH-2 | 0 | 2 | 0 | 0 |
| AUTH-3 | 0 | 3 | 0 | 0 |
| AUTH-4 | 0 | 1 | 0 | 0 |
| AUTH-5 | 0 | 2 | 0 | 0 |
| **Total** | **0** | **14** | **0** | **0** |

> Execution order is the task order within phases: AUTH-1.1 → 1.6, then AUTH-2.x, AUTH-3.x, AUTH-4.1,
> AUTH-5.x. AUTH-3.x may proceed in parallel with AUTH-2.x after AUTH-1 lands.

## Implementation evidence (2026-09-13 — all 14 tasks CODE_COMPLETE)

Gates at completion: `pnpm run typecheck` 0 errors · `pnpm run build` 0 errors · `pnpm run lint` 0 errors
(33 warnings, exactly the pre-existing baseline — zero new). DB-backed gates (the `NEG`/`RLS+` suites,
pre-flight behavior on real data) join the first full CI/DB run.

- **AUTH-1.1** — `drizzle/0043_platform_staff.sql`, journal idx 42, ownership-map `platform_staff`.
  Drizzle schema: `src/common/auth/platform-staff.schema.ts` (kernel location — see AUTH-1.2).
- **AUTH-1.2** — port `PlatformStaffDirectoryPort` in `common/auth/ports.ts`; resolver
  `common/auth/platform-staff.directory.ts` (db + redis only). **Deviation, justified:** the port is bound
  in the GLOBAL KernelModule, not the staff module — `PlatformStaffGuard` is hosted by four modules
  (staff, satellites ×2 controllers, billing price-catalog) and a staff-module binding would have failed
  closed for L1 staff on satellites/billing surfaces. Kernel provider-list addition is justified in
  ADR-014 per `kernel.module.ts`'s locked-list rule. 60s Redis cache (`auth:staff:{accountId}`), explicit
  invalidation on grant/revoke, expiry evaluated at read time.
- **AUTH-1.3** — `common/policy/staff.guard.ts`: L1 resolves through the port (claim retained in the
  principal shape only); unbound directory ⇒ deny; impersonated sessions denied outright. Seeding in
  `modules/staff/platform-staff.admin.ts` (`PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS`, idempotent, audited only on
  change, missing emails skipped with a warning).
- **AUTH-1.4** — `POST /internal/staff/roles`, `DELETE /internal/staff/roles/:accountId` (reason in body),
  `GET /internal/staff/roles`, `GET /internal/staff/roles/me` — super_admin + `@RequireStepUp()` for
  mutations; last-active-super_admin self-revoke blocked; every transition audited
  (`staff.role_granted` / `staff.role_revoked`); L2 callers grant as `system`/`bootstrap` actor.
- **AUTH-1.5** — `drizzle/0044_org_owner_invariant.sql` (journal idx 43): pre-flight DO block aborts on
  duplicate active owners, warns on zero-owner orgs; plain partial unique index (no `DEFERRABLE` — see
  auth_plan.md D2). `translateOwnerInvariant` maps `23505` + constraint name to the stable
  `owner_already_present` conflict in `memberships.service.ts`.
- **AUTH-1.6** — `org-lifecycle.service.ts transferOwnership` is one `withOrg` transaction:
  demote-actor → promote-target (direct UPDATEs, guarded by the index) → post-condition exactly-one count.
  Compensating-rollback block deleted.
- **AUTH-2.1** — `drizzle/0045_org_kind.sql` (journal idx 44), `org_settings.kind` in schema.
- **AUTH-2.2** — **Route reality:** `POST /console/org` on the L1 console controller (the plan's
  `/v1/orgs` mapped to the existing surface convention), `@Idempotent()` + `@RateLimit`. Shared
  `insertOrgWithOwner` (one transaction: tenants INSERT seam + owner membership + eager
  `org_settings{kind:'team'}`, transaction-local RLS context); slug policy (3–63 chars, reserved-word set,
  user-slug 409 vs derived-slug retry); ownership cap `ORGS__MAX_OWNED_PER_ACCOUNT`;
  `EngineEvents.OrgCreated`. **Deviation, justified:** no `@RequireStepUp()` on creation — step-up proofs
  hard-require an MFA challenge and workspace creation is routine self-serve on every major platform;
  the abuse controls are the rate limit, idempotency, and the ownership cap. `createPersonalOrg` was
  refactored onto the same transaction (no more orphan-tenants window on partial failure).
- **AUTH-3.1** — `drizzle/0046_credentials_expand.sql` (journal idx 45): `credential_id` column, partial
  unique indexes, password backfill. `mfa.service.ts` TOTP upsert gained the required `targetWhere`
  (conflict-target inference against a partial index).
- **AUTH-3.2** — `credentials.service.ts` owns password material (`getPasswordHash` / `setPasswordHash`,
  upsert with `targetWhere`); every reader/writer switched: `password.service.ts`,
  `login-interaction.controller.ts` (enumeration resistance preserved), `account-deletion.service.ts`,
  `email-change.service.ts`, `social-account.service.ts`; `AccountsService.updatePasswordHash` removed.
- **AUTH-3.3** — `drizzle/0047_credentials_contract.sql` (journal idx 46) drops `accounts.password_hash`.
  **Release-gate collapse, documented in the migration header:** the one-release dual-read window protects
  deployed data; this repository is pre-first-deploy (one ordered release job applies 0001–0047), so the
  window is zero. If 0046 is ever applied to a deployed environment, hold 0047 for one release cycle.
- **AUTH-4.1** — seat wall inside `MembershipsService.addMember`'s granting transaction: `FOR UPDATE` on
  the seat-bearing entitlement rows → count → insert; re-activations consume no seat; service accounts and
  owners never pass through; stable `seat_limit_reached` (HTTP 402, new `ApiError.seatLimitReached`);
  `ENTITLEMENTS__SEAT_ENFORCEMENT` flag. `invites.redeem` now grants membership BEFORE the single-use
  claim so a 402/capacity refusal does not burn the invite (upsert keeps concurrent redemptions idempotent).
- **AUTH-5.1** — `docs/architecture/engine/decisions/adr-014-enduser-identity-boundary.md` (mandate +
  rejected alternatives + the D1/D2 wave record, including the kernel-list justification).
- **AUTH-5.2** — AGENTS.md "When Stuck" gains the auth_plan/auth_ledger/ADR-014 pointer (file stays under
  the 500-line budget); this tally + evidence section is the ledger reconciliation.
