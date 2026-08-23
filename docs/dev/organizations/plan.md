# Organizations — Implementation Plan

**Workstream:** org furniture — memberships, invites, projects, entitlements (the state machine).
**Binding docs:** 06 §4/§7/§11 (+Δ2/Δ3/Δ4/Δ5), [partitioning.md](../../architecture/partitioning.md) §2 Tier-3, [`console/access-model.md`](../../architecture/console/access-model.md).
**Depends on:** identity I-0/I-1 (accounts must exist for memberships).

## Current state (verified)

- `tenants` = the org (`TenantModel`; `TenantRepository.get_by_slug` with the runtime-cache read-through). API keys bind to `tenant_id`; RLS isolates rows (migration 0014).
- **No memberships, no invites, no projects, no entitlements.** Roles that exist (`super_admin/tenant_admin/operator/auditor` in `auth.py`) are the Neryva-staff overlay — a different axis that stays untouched.

## Target

`owner|admin|billing|developer|reader` memberships on tenants; invites as the only join path; projects as key/limit/usage containers; the platform-owned entitlement state machine `none→trial→active→past_due→suspended→expired`.

## Steps (one commit each; additive migrations)

**O-1 — Schema (migration 0019).** `org_memberships` (UNIQUE(account_id, org_id), role, status, invited_by), `org_invites` (email, org_id, role, single-use `token_hash`, expiry, accepted_at), `projects` (org_id, name, archived_at), `product_entitlements` (org_id, product, plan, status, limits JSONB, period bounds; UNIQUE(org_id, product)); alterations: `api_keys + project_id NULL, owner_account_id NULL, org_id NULL` (backfill as orgs adopt accounts — 06 §11), `end_users + account_id NULL` (consumer upgrade path). RLS: memberships/invites/projects/entitlements are tenant-scoped. *Gate:* migration clean; import health.

**O-2 — Repositories + state machine.** `MembershipRepository` (role checks used by the access matrix), `InviteRepository` (hash-at-rest, expiry, single-use, attempt-capped redemption), `ProjectRepository`, `EntitlementRepository` — **all state transitions live here** (products read state; only billing events move it) with every transition audited (`entitlement.transitioned`). *Gate:* unit tests per transition + invite lifecycle (reuse/expiry/attempt exhaustion).

**O-3 — Access-model enforcement.** New dependencies alongside `require_permission`: `require_membership_role(*roles)` and `require_entitlement(product)` (returns 403 `entitlement_required` / 402 `past_due` per access-model matrix). Δ5: assigning owner/admin, ownership transfer, org deletion ride `require_mfa_proof` (already exists — pure dependency composition). *Gate:* route-level tests for each matrix row (owner/billing/developer/reader × owned/not-owned/past_due).

**O-4 — Org admin API (control-plane furniture).** `/console/org/{members,invites,projects}` CRUD + `/console/org/audit` view — versioned in the pinned contract with `x-neryva-owner: platform`. Personal org auto-created on account signup (ADR-001 context model); joining an existing org happens only via invite redemption. *Gate:* contract re-pin; end-to-end invite→accept→role→revoke scenario test.

## Files touched

`backend/app/infrastructure/db/{models.py,repositories.py}` (+RLS), `backend/alembic/versions/0019_org_furniture.py`, `backend/app/api/dependencies/access.py` (new), `backend/app/api/routes/org.py` (new), `backend/tests/test_org_{memberships,invites,projects,entitlements}.py`, contract re-pin.

## Rollback

All additive; dropping the routes + flag leaves existing tenants untouched (they keep operating exactly as today — a tenant with no memberships behaves as now).
