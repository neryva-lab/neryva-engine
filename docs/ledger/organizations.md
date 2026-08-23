# Ledger — organizations (`modules/organizations`)

**Namespace:** `/console/org/**` (members, invites, projects, groups, service accounts, settings, audit, entitlements, lifecycle) · **Guard:** L1 + membership roles (owner/admin/billing/developer/reader) · **Spec:** [`dev/organizations/plan.md`](../dev/organizations/plan.md), [access-model](../architecture/console/access-model.md).
**State:** O-1…O-4 shipped (eng-0002); staged deletion + purge + transfer shipped (eng-0010); dense pass shipped (eng-0009 — groups, service accounts, settings, audit query/export, suspension, invite lifecycle, seats/trials).

## Phases

### O-1 — Schema
- [x] `org_memberships` (UNIQUE(account,org), role, status, invited_by, last_active_at, suspended_at/by) · `org_invites` (single-use hashed token, expiry, resend_count) · `projects` (created_by, archived_by) · `product_entitlements` (UNIQUE(org,product); limits JSONB, seats, source)
- [x] eng-0009: `org_settings` (support email, default project, branding, preferences) · `org_groups` + `org_group_members` (denormalized org_id for RLS) · `org_service_accounts` (GLOBALLY unique token hash — auth resolves before org context) · `org_deletions`
- **Gate:** migrations clean (0002 + 0009); RLS policies on all tenant-scoped tables

### O-2 — Repositories + the entitlement state machine
- [x] Membership/Invite/Project services; invite lifecycle (expiry, single-use, attempt caps, resend-with-token-rotation, extend)
- [x] `EntitlementsService`: **platform-owned** transitions `none→trial→active→past_due→suspended→expired`, every transition audited (`entitlement.transitioned`); seats + source travel with state; console trial start (owner/billing, once per product, tagged `console.trial`); effective-limits resolution with status overlays
- **Gate:** transition-table discipline; billing (quota/usage-query) consumes the views

### O-3 — Access enforcement (Δ4/Δ5)
- [x] `@Roles(...)` membership guard + `@RequireEntitlement(product)` guard (403 `entitlement_required` / 402 `past_due`)
- [x] Privileged acts behind step-up MFA: declarative `@RequireStepUp()` where whole-route; imperative `assertFreshMfaProof` where the act is body-conditional (role→owner/admin, invite-as-admin); SA create/rotate step-up (keys-module parity)
- **Gate:** every route carries its matrix row

### O-4 — Org admin API
- [x] Members (enriched inventory w/ pagination+search, detail, role change, suspend/reactivate, remove, leave) + invites (create/list/revoke/resend/extend/redeem) + projects (CRUD/archive/unarchive) + entitlements (list/get/trial) + summary cards
- [x] Personal org auto-created at signup; joining existing orgs **only** via invite redemption
- **Gate:** invite→accept→role→revoke flow audited end-to-end

### O-5 — Dense pass (eng-0009)
- [x] Groups CRUD + membership (view all, manage owner/admin)
- [x] Service accounts: create (token once)/list/rotate/revoke-token/disable/enable/delete; `nrv_sa_` tokens authenticate as L2 via `SERVICE_ACCOUNT_DIRECTORY_PORT` (fail-closed); per-token rate limit + audit-failure trail parity with `nrv_live_`
- [x] Org profile + settings: tenants-seam writes (name/region/retention, audited from→to), branding (validated data-URL ≤2MB, hex color), preferences whitelist, default-project validation
- [x] Audit surfaces: filtered query (actor/action/resource/window, paginated w/ total), facets, bounded CSV/JSON export (10k cap, SIEM posture)
- [x] Lifecycle: staged deletion (immediate effects incl. SA token voiding), cancel, status, grace-window export, ownership transfer w/ email; purge covers all eng-0009 tables
- [x] Events + email: full org event vocabulary; member-removed/role-changed/suspended, deletion requested/cancelled, ownership transfer notices
- **Gate:** typecheck clean; module compiles standalone against the kernel ports

## Known follow-ups (deliberate, documented)
- SCIM/directory sync + SSO-required orgs (access-model enterprise row) — blocked on identity enterprise tier
- Contract re-pin (`x-neryva-owner: platform`) once the frontend `/platform/**` wiring lands
- Frontend role-label reconciliation (pickers say Editor/Viewer; canonical set is billing/developer/reader)
