# Ledger — organizations (`modules/organizations`)

**Namespace:** `/console/org/**` (members, invites, projects) · **Guard:** L1 + membership roles (owner/admin/billing/developer/reader) · **Spec:** [`dev/organizations/plan.md`](../dev/organizations/plan.md), [access-model](../architecture/console/access-model.md).
**Current state (verified):** `tenants` exists (= the org, RLS-isolated); **no memberships, invites, projects, or entitlements anywhere** — net-new in TS.

## Phases

### O-1 — Schema
- [ ] `org_memberships` (UNIQUE(account,org), role, status, invited_by) · `org_invites` (single-use hashed token, expiry) · `projects` · `product_entitlements` (UNIQUE(org,product); limits JSONB)
- [ ] Alterations: `api_keys + project_id/owner_account_id/org_id` (nullable) · `end_users + account_id` (nullable) — coordinated with [`billing-metering`](billing-metering.md) and [`agent-runtime`](agent-runtime.md) A-2 (that table stays runtime-hosted until handover; alteration deferred to A-2)
- **Gate:** migrations clean; RLS policies on all tenant-scoped tables

### O-2 — Repositories + the entitlement state machine
- [ ] Membership/Invite/Project repositories; invite lifecycle (expiry, single-use, attempt caps)
- [ ] `EntitlementRepository`: **platform-owned** transitions `none→trial→active→past_due→suspended→expired`, every transition audited (`entitlement.transitioned`)
- **Gate:** unit test per transition + invite lifecycle

### O-3 — Access enforcement (Δ4/Δ5)
- [ ] `@Roles(...)` membership guard + `@RequireEntitlement(product)` guard (403 `entitlement_required` / 402 `past_due`)
- [ ] Privileged acts (owner/admin assignment, ownership transfer, org deletion, purchases) behind step-up MFA guard
- **Gate:** route tests for every access-model matrix row

### O-4 — Org admin API
- [ ] Members/invites/projects CRUD + `/console/org/audit` view; contract-pinned (`x-neryva-owner: platform`)
- [ ] Personal org auto-created at signup; joining existing orgs **only** via invite redemption
- **Gate:** invite→accept→role→revoke end-to-end test; contract snapshot in CI
