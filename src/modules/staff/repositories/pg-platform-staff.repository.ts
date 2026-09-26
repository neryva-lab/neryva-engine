/**
 * PostgreSQL lane for `IPlatformStaffRepository` (P3).
 *
 * Mechanical extraction from `PlatformStaffAdminService`: `db.root`
 * (platform-plane, no RLS) operations on the `platform_staff` table.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbService } from '../../../common/infra/db/db.service';
import { platformStaff, type PlatformStaffRow } from '../../../common/auth/platform-staff.schema';
import { accounts } from '../../identity/schema';
import type {
  IPlatformStaffRepository,
  PlatformStaff,
  PlatformStaffListRow,
  UpsertPlatformStaffInput,
} from './platform-staff.repository';

function toPlatformStaff(row: PlatformStaffRow): PlatformStaff {
  return {
    accountId: row.accountId,
    role: row.role,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
  };
}

export class PgPlatformStaffRepository implements IPlatformStaffRepository {
  constructor(private readonly db: DbService) {}

  async upsert(input: UpsertPlatformStaffInput): Promise<PlatformStaff[]> {
    const rows = await this.db.root
      .insert(platformStaff)
      .values({
        accountId: input.accountId,
        role: input.role,
        grantedBy: input.grantedBy,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: platformStaff.accountId,
        set: {
          role: input.role,
          grantedBy: input.grantedBy,
          grantedAt: input.nowIso,
          expiresAt: input.expiresAt,
          revokedAt: null,
          revokeReason: null,
        },
      })
      .returning();
    return rows.map(toPlatformStaff);
  }

  async findByAccountId(accountId: string): Promise<PlatformStaff | null> {
    const rows = await this.db.root
      .select()
      .from(platformStaff)
      .where(eq(platformStaff.accountId, accountId))
      .limit(1);
    return rows[0] ? toPlatformStaff(rows[0]) : null;
  }

  async revoke(accountId: string, reason: string | null, nowIso: string): Promise<void> {
    await this.db.root
      .update(platformStaff)
      .set({ revokedAt: nowIso, revokeReason: reason })
      .where(eq(platformStaff.accountId, accountId));
  }

  async list(): Promise<PlatformStaffListRow[]> {
    return this.db.root
      .select({
        accountId: platformStaff.accountId,
        email: accounts.email,
        displayName: accounts.displayName,
        role: platformStaff.role,
        grantedAt: platformStaff.grantedAt,
        expiresAt: platformStaff.expiresAt,
        revokedAt: platformStaff.revokedAt,
      })
      .from(platformStaff)
      .leftJoin(accounts, eq(accounts.id, platformStaff.accountId));
  }

  async countActiveSuperAdmins(_nowIso: string): Promise<number> {
    const rows = await this.db.root
      .select({ n: sql<number>`count(*)::int` })
      .from(platformStaff)
      .where(
        and(
          eq(platformStaff.role, 'super_admin'),
          isNull(platformStaff.revokedAt),
          sql`(${platformStaff.expiresAt} IS NULL OR ${platformStaff.expiresAt} > now())`,
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}
