/**
 * PostgreSQL content-staff repository (P3) — `corporate_content_staff`.
 * Mechanical move of the `ContentStaffGuard` + staff-management persistence.
 * Corporate tables are global (non-tenant, no RLS) — every method runs
 * through `withBypass`, matching the original `db.root` usage.
 */
import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { corporateContentStaff } from '../public.schema';
import type { ContentStaffGrantRow, IContentStaffRepository } from './content-staff.repository';

export class PgContentStaffRepository implements IContentStaffRepository {
  constructor(private readonly db: DbService) {}

  async isContentStaff(accountId: string): Promise<boolean> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ accountId: corporateContentStaff.accountId })
        .from(corporateContentStaff)
        .where(eq(corporateContentStaff.accountId, accountId))
        .limit(1),
    );
    return !!rows[0];
  }

  async listGrants(): Promise<ContentStaffGrantRow[]> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx.select().from(corporateContentStaff);
      return rows.map((r) => ({ accountId: r.accountId, grantedBy: r.grantedBy, grantedAt: r.grantedAt }));
    });
  }

  async grantStaff(input: { accountId: string; grantedBy: string }): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .insert(corporateContentStaff)
        .values({ accountId: input.accountId, grantedBy: input.grantedBy })
        .onConflictDoNothing({ target: corporateContentStaff.accountId });
    });
  }

  async revokeStaff(accountId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.delete(corporateContentStaff).where(eq(corporateContentStaff.accountId, accountId));
    });
  }
}
