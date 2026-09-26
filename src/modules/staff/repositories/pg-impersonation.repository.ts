/**
 * PostgreSQL lane for `IImpersonationRepository` (P3).
 *
 * Mechanical extraction from `StaffImpersonationService`: `db.root`
 * (platform-plane, no RLS) inserts/selects/updates on the
 * `staff_impersonations` table, plus the sweep join against
 * `oauth_sessions`.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DbService } from '../../../common/infra/db/db.service';
import { staffImpersonations } from '../schema';
import type {
  CreateImpersonationInput,
  IImpersonationRepository,
  Impersonation,
} from './impersonation.repository';

function toImpersonation(row: typeof staffImpersonations.$inferSelect): Impersonation {
  return {
    id: row.id,
    staffAccountId: row.staffAccountId,
    targetAccountId: row.targetAccountId,
    orgId: row.orgId,
    reason: row.reason,
    sessionSid: row.sessionSid,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export class PgImpersonationRepository implements IImpersonationRepository {
  constructor(private readonly db: DbService) {}

  async create(input: CreateImpersonationInput): Promise<{ id: string }> {
    const inserted = await this.db.root
      .insert(staffImpersonations)
      .values({
        staffAccountId: input.staffAccountId,
        targetAccountId: input.targetAccountId,
        orgId: input.orgId,
        reason: input.reason,
        sessionSid: input.sessionSid,
        expiresAt: input.expiresAt,
      })
      .returning({ id: staffImpersonations.id });
    return { id: inserted[0].id };
  }

  async findById(impersonationId: string): Promise<Impersonation | null> {
    const rows = await this.db.root
      .select()
      .from(staffImpersonations)
      .where(eq(staffImpersonations.id, impersonationId))
      .limit(1);
    return rows[0] ? toImpersonation(rows[0]) : null;
  }

  async revoke(impersonationId: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(staffImpersonations)
      .set({ revokedAt: nowIso })
      .where(eq(staffImpersonations.id, impersonationId));
  }

  async listActive(limit = 100): Promise<Impersonation[]> {
    const rows = await this.db.root
      .select()
      .from(staffImpersonations)
      .where(and(isNull(staffImpersonations.revokedAt), sql`${staffImpersonations.expiresAt} > now()`))
      .orderBy(desc(staffImpersonations.createdAt))
      .limit(limit);
    return rows.map(toImpersonation);
  }

  async findExpiredUnrevokedSessionSids(limit: number): Promise<string[]> {
    const result = await this.db.root.execute<{ sid: string }>(sql`
      select i.session_sid as sid
      from staff_impersonations i
      join oauth_sessions s on s.sid = i.session_sid
      where i.revoked_at is null and i.expires_at < now() and s.revoked_at is null
      limit ${limit}
    `);
    return result.rows.map((row) => row.sid);
  }
}
