# Organizations — Implementation Plan

**Workstream:** org furniture — memberships, invites, projects, entitlements (the state machine), and the eng-0009 dense pass (groups, service accounts, settings, audit surfaces).
**Binding docs:** 06 §4/§7/§11 (+Δ2/Δ3/Δ4/Δ5), [partitioning.md](../../architecture/partitioning.md) §2 Tier-3, [`console/access-model.md`](../../architecture/console/access-model.md).
**Depends on:** identity I-0/I-1 (accounts must exist for memberships).

**Status: COMPLETE (O-1…O-4 shipped as eng-0002/eng-0010 in TS; dense pass below shipped as eng-0009).** The original plan targeted the Python backend; the engine (ADR-005) owns the implementation now.

## Current state (verified 2026-08-23)

- `tenants` = the org (`TenantModel`; Python-owned DDL, engine writes through documented seams). RLS isolates engine org tables by org_id.
- Shipped: memberships (statuses, heartbeat, suspension), invites (full lifecycle), projects (CRUD+archive), entitlements (state machine + seats + trials), groups, service accounts (`nrv_sa_` L2 via SERVICE_ACCOUNT_DIRECTORY_PORT), org settings/profile, audit query/facets/export, staged deletion + purge worker, ownership transfer.

## Dense pass (eng-0009) — the competitive-parity set

Benchmarked against OpenAI Platform (service accounts in the member inventory, org/project split, audit log API), Vercel teams (member roles, audit export/SIEM, scoped machine identities), WorkOS (invite lifecycle create/resend/extend, groups), GitHub (suspend-before-remove, org audit trail):

- **Members:** enriched inventory (email, display name, 2FA level, email-verified, last login, org-context last active, groups), pagination + search, suspend/reactivate (first-class reversible state; owners immune), remove (admin limited to non-owner/admin targets), leave (last-owner guard), role changes (owner/admin targets = owner + step-up), summary cards (members by status, pending invites, SAs, groups).
- **Invites:** create guards (duplicate pending, already-member, pending cap, invitable-roles only — ownership arrives via transfer), resend = token ROTATION (attempts reset, TTL restart, concurrency-guarded), extend expiry without token churn, computed status on every row.
- **Projects:** rename/update, unarchive, provenance columns, `include_archived` view.
- **Entitlements:** seats + source columns, console trial starts (owner/billing, once per product), effective-limits resolution (trial/read-only/entitled overlays).
- **Groups:** CRUD + membership junction (denormalized org_id for RLS); view all roles, manage owner/admin; never bypasses the role matrix.
- **Service accounts:** one live `nrv_sa_` token (sha256 at rest, shown once), rotate/revoke/disable/enable, last-used telemetry, AuthGuard resolution as org-scoped L2 (`role: service_account`), per-token rate limit + auth-failure audit parity with `nrv_live_` keys.
- **Settings/profile:** tenants-seam writes (name/region/retention — audited from→to), branding (validated logo data-URL ≤2MB, hex color), preferences whitelist (runtime defaults, retention knobs, auto-rollback, canary), default-project validation.
- **Audit:** filtered/paginated query, distinct facets, bounded CSV/JSON export (10k cap).
- **Lifecycle:** deletion request voids SA tokens too; grace-window export; purge covers all eng-0009 tables; emails for member removed/suspended/role-changed, deletion requested/cancelled, ownership transfer.

## Remaining (tracked in the ledger)

SCIM + SSO-required orgs (enterprise tier), contract re-pin when `/platform/**` wiring lands, frontend role-label reconciliation.

