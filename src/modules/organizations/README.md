# organizations (`src/modules/organizations`)

**Purpose:** org furniture — memberships, invites, projects, entitlements,
groups, service accounts, settings, audit surfaces, and the staged-deletion
lifecycle (doc-06 Δ2/Δ3/Δ4/Δ5; ledger O-1…O-4; dense pass eng-0009).

**Routes:** `/console/org/**` (L1 + membership roles; step-up on privileged
acts) + `GET /console/org/contexts` (org picker). Controllers:
`org.controller` (contexts, profile, settings, summary, entitlements, invite
redemption), `org-members.controller` (members + invites), `org-projects`,
`org-groups`, `org-service-accounts`, `org-audit`, `org-lifecycle`.

**Tables (engine-owned, eng-0002 + eng-0009, RLS per org_id):**
org_memberships (heartbeat, suspension provenance), org_invites (resend
tracking), projects (provenance), product_entitlements (seats, source),
org_settings, org_groups, org_group_members, org_service_accounts
(globally-unique token hash), org_deletions. `org_id` is varchar(36)
matching the Python-owned `tenants.id` — reference by id, never by FK.

**Flag:** `MODULES__ORGANIZATIONS_ENABLED` (requires identity).

**Semantics:**
- Roles: owner | admin | billing | developer | reader (converged set);
  owner/admin assignment, ownership transfer, org deletion, SA token
  minting are step-up gated (declarative guard or `assertFreshMfaProof`
  when the privileged act rides the request body)
- Invites are the ONLY join path: 32-byte token hashed at rest, single-use,
  configurable TTL (ORG_INVITE_TTL_DAYS), 5-attempt cap, email-bound
  redemption; full lifecycle create/resend (token rotation)/extend/revoke;
  ownership is never granted by invitation — only via transfer
- Member statuses: active | suspended | removed — suspension is a
  first-class, reversible access off-switch; exactly-one-active-owner
  invariant enforced in the service layer; org-context activity heartbeat
  throttled-writes last_active_at from the role-lookup path
- Service accounts (OpenAI-platform pattern): org-owned machine identities
  in the member inventory; `nrv_sa_` tokens resolve as L2 principals via
  the kernel's SERVICE_ACCOUNT_DIRECTORY_PORT (fails closed when this
  module is disabled); at most one live token, rotate/revoke/disable
- Groups (WorkOS pattern): named membership collections; view all, manage
  owner/admin; group membership never bypasses the role matrix
- Entitlement state machine: none→trial→active→past_due→suspended→expired
  with an explicit transition table; every move audited
  (`entitlement.transitioned`); console trial starts (owner/billing) are
  the one non-billing writer, tagged source=console.trial; effective
  limits resolve status overlays (trial/read_only/entitled) for products
- Audit: filtered/paginated query + distinct facets + bounded CSV/JSON
  export (SIEM posture); reads filter tenant_id explicitly on the shared
  chain (no RLS on audit_events — Python-owned DDL)
- Staged deletion: request (immediate effects: entitlements expire, invites
  + keys + SA tokens revoke) → grace window (ORG_DELETION_GRACE_DAYS,
  cancel-able, export available) → daily purge worker erases engine-owned
  rows and marks the tenants row deleted via its features jsonb
- Personal org autocreation on `account.created` (inserts into the
  Python-owned `tenants` using the TenantModel column set — documented
  dual-write seam in `ownership-map.json`)

**Public interface:** `MembershipsService`, `InvitesService`,
`ProjectsService`, `EntitlementsService`, `OrgSettingsService`,
`OrgGroupsService`, `OrgServiceAccountsService`, `OrgAuditService`,
`OrgAccessService`, `OrgLifecycleService`, `ORG_ACCESS_PORT` (kernel
Roles/Entitlement guards), `SERVICE_ACCOUNT_DIRECTORY_PORT` (L2 `nrv_sa_`
resolution in the auth guard).
