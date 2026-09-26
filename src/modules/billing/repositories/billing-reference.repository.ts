/**
 * `IBillingReferenceRepository` — the billing cross-domain read port (P3).
 *
 * Billing touches three tables it does not own (organizations/legacy
 * plane): `tenants` (org existence), `projects` (project→org ownership),
 * and `product_entitlements` (expired-trial sweep). Per the P3 architecture
 * contract, cross-domain reads use an explicit read-port interface rather
 * than direct cross-schema queries — this is that port. When the
 * organizations module gets its own persistence ports, this port's
 * implementations should delegate to them instead of reading the tables.
 *
 * All three reads are deliberately global (no tenant scope): they answer
 * "does this id exist / who owns it" for the ingest pre-check and the
 * cross-tenant trial sweep.
 */
export interface ExpiredTrialRow {
  id: string;
  orgId: string;
  product: string;
}

export interface ProjectOwnershipRow {
  id: string;
  orgId: string;
}

export interface IBillingReferenceRepository {
  /** The subset of `ids` that exist as tenants. */
  findTenantIds(ids: string[]): Promise<string[]>;

  /** The (id, org_id) pairs for the given project ids. */
  findProjectsByIds(ids: string[]): Promise<ProjectOwnershipRow[]>;

  /** Entitlements in `trial` status with a `period_end` before `nowIso`. */
  findExpiredTrials(nowIso: string): Promise<ExpiredTrialRow[]>;
}
