import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { legacyTenants } from '../../../common/infra/db/legacy-schema';
import { productEntitlements, projects } from '../../organizations/schema';
import type {
  ExpiredTrialRow,
  IBillingReferenceRepository,
  ProjectOwnershipRow,
} from './billing-reference.repository';

/**
 * PostgreSQL `IBillingReferenceRepository` (P3). Mechanical extraction of
 * the cross-domain reads from `SpendIngestService.precheck` and
 * `TrialExpiryService.sweep`.
 */
@Injectable()
export class PgBillingReferenceRepository implements IBillingReferenceRepository {
  constructor(private readonly db: DbService) {}

  async findTenantIds(ids: string[]): Promise<string[]> {
    // tenants/projects are Python-owned/engine-shared tables without RLS —
    // explicit id filters, parameterized via inArray (never interpolation).
    const orgRows = await this.db.root
      .select({ id: legacyTenants.id })
      .from(legacyTenants)
      .where(inArray(legacyTenants.id, ids));
    return orgRows.map((r) => r.id);
  }

  async findProjectsByIds(ids: string[]): Promise<ProjectOwnershipRow[]> {
    const rows: ProjectOwnershipRow[] = [];
    if (ids.length > 0) {
      const projectRows = await this.db.root
        .select({ orgId: projects.orgId, id: projects.id })
        .from(projects)
        .where(inArray(projects.id, ids));
      for (const row of projectRows) {
        rows.push({ id: row.id, orgId: row.orgId });
      }
    }
    return rows;
  }

  async findExpiredTrials(nowIso: string): Promise<ExpiredTrialRow[]> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ id: productEntitlements.id, orgId: productEntitlements.orgId, product: productEntitlements.product })
        .from(productEntitlements)
        .where(and(eq(productEntitlements.status, 'trial'), isNotNull(productEntitlements.periodEnd), lt(productEntitlements.periodEnd, nowIso))),
    );
    return rows.map((row) => ({ id: row.id, orgId: row.orgId, product: row.product }));
  }
}
