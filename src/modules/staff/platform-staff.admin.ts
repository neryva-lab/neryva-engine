import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { RedisService } from '../../common/infra/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { platformStaffCacheKey } from '../../common/auth/platform-staff.directory';
import { platformStaff, type PlatformStaffRow } from '../../common/auth/platform-staff.schema';
import { AccountsService } from '../identity/accounts.service';
import { accounts } from '../identity/schema';

export type PlatformStaffRole = 'super_admin' | 'tenant_admin' | 'operator' | 'auditor';

export const PLATFORM_STAFF_ROLES: readonly PlatformStaffRole[] = ['super_admin', 'tenant_admin', 'operator', 'auditor'] as const;

/**
 * Management surface for the platform staff binding (auth_plan.md D1) — the
 * staff module's counterpart to the kernel-level resolver
 * (common/auth/platform-staff.directory.ts). Everything here needs account
 * lookups and the audit chain, which is why it lives behind the identity
 * import instead of the kernel.
 *
 * Grant/revoke invalidate the same 60s Redis entry the resolver reads, so a
 * transition bites on the caller's NEXT request. The last active super_admin
 * cannot revoke themselves (break-glass = grant another first). Bootstrap
 * seeding (PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS) is the cold-start path and is
 * audited only when it actually changes a row — no churn on every boot.
 */
@Injectable()
export class PlatformStaffAdminService implements OnModuleInit {
  private static readonly logger = new Logger(PlatformStaffAdminService.name);

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  /** Cold start: upsert PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS to super_admin. */
  async onModuleInit(): Promise<void> {
    const emails = env.PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);
    for (const email of emails) {
      const account = await this.accounts.findByEmail(email).catch(() => null);
      if (!account) {
        PlatformStaffAdminService.logger.warn(`[staff] bootstrap account not found for "${email}" — seed the account before boot`);
        continue;
      }
      const existing = await this.findByPk(account.id);
      if (existing && !existing.revokedAt && existing.role === 'super_admin') {
        continue;
      }
      await this.upsert(account.id, 'super_admin', null, null);
      await this.invalidate(account.id);
      await this.audit.add({
        action: 'staff.role_granted',
        resourceType: 'platform_staff',
        resourceId: account.id,
        actorType: 'system',
        details: { role: 'super_admin', bootstrap: true, email_hash_prefix: email.slice(0, 2) },
      });
    }
  }

  // ── management (controller: @StaffRoles('super_admin') + @RequireStepUp()) ──

  async grant(input: { accountId: string; role: PlatformStaffRole; expiresAt: string | null; grantedBy: string | null }): Promise<void> {
    if (input.expiresAt !== null && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw ApiError.validation({ expires_at: 'must be an ISO timestamp' });
    }
    if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now()) {
      throw ApiError.validation({ expires_at: 'must be in the future' });
    }
    const account = await this.accounts.findById(input.accountId).catch(() => null);
    if (!account) {
      throw ApiError.notFound('account');
    }
    const existing = await this.findByPk(input.accountId);
    if (existing && !existing.revokedAt && existing.role === input.role && sameExpiry(existing.expiresAt, input.expiresAt)) {
      return; // idempotent re-grant — no churn, no audit noise
    }
    await this.upsert(input.accountId, input.role, input.expiresAt, input.grantedBy);
    await this.invalidate(input.accountId);
    await this.audit.add({
      action: 'staff.role_granted',
      resourceType: 'platform_staff',
      resourceId: input.accountId,
      actorType: input.grantedBy ? 'account' : 'system',
      actorId: input.grantedBy ?? 'bootstrap',
      details: { role: input.role, expires_at: input.expiresAt, previous_role: existing?.role ?? null },
    });
  }

  async revoke(input: { accountId: string; reason: string | null; revokedBy: string }): Promise<void> {
    const existing = await this.findByPk(input.accountId);
    if (!existing || existing.revokedAt) {
      throw ApiError.notFound('staff binding');
    }
    if (existing.role === 'super_admin' && (await this.countActiveSuperAdmins()) <= 1) {
      throw ApiError.conflict('cannot revoke the last active super_admin — grant another first');
    }
    await this.db.root
      .update(platformStaff)
      .set({ revokedAt: new Date().toISOString(), revokeReason: input.reason })
      .where(eq(platformStaff.accountId, input.accountId));
    await this.invalidate(input.accountId);
    await this.audit.add({
      action: 'staff.role_revoked',
      resourceType: 'platform_staff',
      resourceId: input.accountId,
      actorType: 'account',
      actorId: input.revokedBy,
      details: { role: existing.role, reason: input.reason },
    });
  }

  async list(): Promise<
    Array<{ accountId: string; email: string | null; displayName: string | null; role: string; grantedAt: string; expiresAt: string | null; revokedAt: string | null }>
  > {
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

  // ── internals ──────────────────────────────────────────────────────────────

  private async upsert(accountId: string, role: PlatformStaffRole, expiresAt: string | null, grantedBy: string | null): Promise<PlatformStaffRow[]> {
    return this.db.root
      .insert(platformStaff)
      .values({ accountId, role, grantedBy, expiresAt })
      .onConflictDoUpdate({
        target: platformStaff.accountId,
        set: { role, grantedBy, grantedAt: new Date().toISOString(), expiresAt, revokedAt: null, revokeReason: null },
      })
      .returning();
  }

  private async findByPk(accountId: string): Promise<PlatformStaffRow | null> {
    const rows = await this.db.root.select().from(platformStaff).where(eq(platformStaff.accountId, accountId)).limit(1);
    return rows[0] ?? null;
  }

  private async countActiveSuperAdmins(): Promise<number> {
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

  private async invalidate(accountId: string): Promise<void> {
    await this.redis.raw.del(platformStaffCacheKey(accountId)).catch(() => undefined);
  }
}

function sameExpiry(a: string | null, b: string | null): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return Date.parse(a) === Date.parse(b);
}
