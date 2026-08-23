# organizations (`src/modules/organizations`)

**Purpose:** org furniture — memberships, invites, projects, entitlements
(doc-06 Δ2/Δ3/Δ4/Δ5; ledger O-1…O-4).

**Routes:** `/console/org/**` (L1 + membership roles; step-up on privileged
acts) + `GET /console/org/contexts` (org picker).

**Tables (engine-owned, eng-0002, RLS per org_id):** org_memberships,
org_invites, projects, product_entitlements. `org_id` is varchar(36) matching
the Python-owned `tenants.id` — reference by id, never by FK.

**Flag:** `MODULES__ORGANIZATIONS_ENABLED` (requires identity).

**Semantics:**
- Roles: owner | admin | billing | developer | reader (converged set)
- Invites are the ONLY join path: 32-byte token hashed at rest, single-use,
  7-day expiry, 5-attempt cap, email-bound redemption
- Exactly-one-active-owner invariant enforced in the service layer
- Entitlement state machine: none→trial→active→past_due→suspended→expired
  with an explicit transition table; every move audited
  (`entitlement.transitioned`)
- Personal org autocreation on `account.created` (inserts into the
  Python-owned `tenants` using the TenantModel column set — documented
  dual-write seam in `ownership-map.json`)

**Public interface:** `MembershipsService`, `InvitesService`,
`ProjectsService`, `EntitlementsService`, `OrgAccessService`,
`ORG_ACCESS_PORT` binding (consumed by the kernel's Roles/Entitlement guards).
