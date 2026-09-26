import type { IOrgInfoRepository, OrgBrief } from './repositories/org-info.repository';

export type { OrgBrief };

/**
 * Shared read helpers against the Python-owned `tenants` row (explicit
 * filtered cross-system reads per partitioning §5 — the engine never joins
 * its own FKs into that DDL, it reads by id). The persistence lives behind
 * `IOrgInfoRepository` (selected by `DB_PROVIDER` in `OrganizationsModule`);
 * these shims keep the call sites terse.
 *
 * The `getName` fallback ('your organization') is a service-layer contract —
 * email/notification copy must never render a blank or throw when the row
 * is missing.
 */
export async function getOrgBrief(repo: IOrgInfoRepository, orgId: string): Promise<OrgBrief | null> {
  return repo.getBrief(orgId);
}

export async function getOrgName(repo: IOrgInfoRepository, orgId: string): Promise<string> {
  return repo.getName(orgId);
}
