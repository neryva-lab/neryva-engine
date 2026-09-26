/**
 * Org-access repository (P3) — the persistence port for the org-creation
 * transaction and the ownership-capacity read (`OrgAccessService`:
 * ADR-001 personal-org autocreation + AUTH-2.2 team-workspace creation).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * The `tenants` row is Python-owned (ownership map: engine may INSERT new
 * orgs using the TenantModel column set — the DDL authority stays Python
 * until handover A-1). The defaults in `createOrgWithOwner` mirror Python's
 * model defaults so the runtime reads these rows without surprises. The
 * `tenants` INSERT is deliberately unscoped — every access is by the new
 * org's explicit id; the PostgreSQL implementation writes through
 * `DbService.root` in a transaction with transaction-local tenant context
 * (the RLS-guarded membership/settings inserts must admit the new org),
 * and the MongoDB implementation uses a `PlatformCollection` with a
 * justifying comment, mirroring the pg lane.
 *
 * The interface carries no drizzle or mongodb runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - slug normalization/validation (normalizeTeamSlug / deriveTeamSlug)
 * - the reserved-slug set and the 409 for reserved slugs
 * - the creation retry loops (personal: 5 attempts; derived team slugs: 5;
 *   user-chosen team slugs: 1 — the repo throws the slug_taken conflict
 *   and the service decides retry vs 409 by attempt budget)
 * - the ownership-capacity threshold comparison (the repo returns the count)
 * - audit writes (`org.created`) and event emission (`OrgCreated`)
 */
export interface IOrgAccessRepository {
  /**
   * The shared creation transaction (personal + team) — the Python-owned
   * `tenants` row (documented INSERT seam — engine inserts, Python owns
   * DDL until handover A-1), the owner membership, and (team only) the
   * eager `org_settings` row, all atomic. Explicit columns including
   * `created_at`/`updated_at`, mirroring the service's original write.
   *
   * A slug collision throws `ApiError.conflict('that workspace address is
   * already taken', { reason: 'slug_taken' })` on both lanes (pg: the
   * `uq_tenants_slug` 23505; mongo: 11000 on the `tenants` slug unique
   * index → the same ApiError). The service drops its old `pgViolation`
   * mapping for this call — behavior-preserving (same 409).
   */
  createOrgWithOwner(input: {
    orgId: string;
    slug: string;
    name: string;
    accountId: string;
    kind: 'personal' | 'team';
  }): Promise<void>;

  /**
   * Cross-org count of active owner memberships for the account (the
   * AUTH-2.2 abuse cap read). Justification: the caller's own ownership
   * rows span orgs by definition; the query filters account_id explicitly.
   * The pg lane uses `withBypass`; the mongo lane an unscoped
   * PlatformCollection read with this same justification.
   */
  countOwnedOrgs(accountId: string): Promise<number>;
}
