/**
 * DI tokens for the organizations-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `OrganizationsModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 *
 * Cluster agents: APPEND your token consts below the marker. Do not
 * reorder or edit existing entries.
 */

// ── cluster agents append token consts below ──────────────────────────────

// ── furniture clusters (P3): one token per aggregate/transaction-boundary ──
export const ENTITLEMENT_REPOSITORY = Symbol('IEntitlementRepository');
export const PROJECT_REPOSITORY = Symbol('IProjectRepository');
export const GROUP_REPOSITORY = Symbol('IGroupRepository');
export const SERVICE_ACCOUNT_REPOSITORY = Symbol('IServiceAccountRepository');
export const ORG_SETTINGS_REPOSITORY = Symbol('IOrgSettingsRepository');
export const ORG_AUDIT_REPOSITORY = Symbol('IOrgAuditRepository');

// ── memberships / invites clusters (P3) ────────────────────────────────────
export const MEMBERSHIP_REPOSITORY = Symbol('IMembershipRepository');
export const INVITE_REPOSITORY = Symbol('IInviteRepository');

// ── info / lifecycle / access clusters (P3) ───────────────────────────────
export const ORG_INFO_REPOSITORY = Symbol('IOrgInfoRepository');
export const ORG_LIFECYCLE_REPOSITORY = Symbol('IOrgLifecycleRepository');
export const ORG_ACCESS_REPOSITORY = Symbol('IOrgAccessRepository');
