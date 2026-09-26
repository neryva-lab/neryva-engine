import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../../../common/infra/db/db.service';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { ApiError } from '../../../common/http/api-error';
import { env } from '../../../common/config/env';
import { accounts } from '../../identity/schema';
import {
  orgGroupMembers,
  orgGroups,
  orgInvites,
  orgMemberships,
  orgServiceAccounts,
  productEntitlements,
} from '../schema';
import type { OrgRole } from '../schema';
import type {
  IMembershipRepository,
  MemberListRow,
  MembershipRow,
  MembershipSummary,
} from './membership.repository';
import { LAST_ACTIVE_WRITE_THRESHOLD_MS } from './membership.repository';

/**
 * AUTH-1.5: the partial unique index uq_one_active_owner_per_org
 * (drizzle/0044) is the concurrency backstop for the exactly-one-owner
 * invariant — any statement that would leave a second active owner fails at
 * the database. Translate that specific violation into the stable API error
 * instead of leaking a raw 23505; every other error propagates unchanged.
 */
function translateOwnerInvariant(err: unknown): unknown {
  const pg = pgViolation(err);
  if (pg.code === '23505' && pg.constraint === 'uq_one_active_owner_per_org') {
    return ApiError.conflict('the organization already has an active owner — transfer ownership instead', { reason: 'owner_already_present' });
  }
  return err;
}

/**
 * PostgreSQL implementation of `IMembershipRepository` (P3).
 *
 * Mechanical move of the `MembershipsService` persistence units: every
 * method owns its transaction via `DbService.withOrg` (or `withBypass` /
 * `root` where the service did), runs all reads/writes inside it, and
 * commits or rolls back as one. No transaction handle leaks through this
 * interface. SQL, lock modes (`for('update')`), and `ApiError` throws are
 * preserved exactly as they were in the service.
 *
 * Note: the identity-plane `accounts` join (listMembers) is a cross-module
 * schema import the service already carried — the accounts table is
 * platform-plane (no RLS), read here only for the inventory enrichment.
 *
 * What stays OUT (still the service's job): input validation (`assertRole`),
 * the owner-policy guards (the service reads the owners and throws), audit
 * writes, event emission, member notification emails, and tracing spans.
 */
export class PgMembershipRepository implements IMembershipRepository {
  constructor(private readonly db: DbService) {}

  async listMembers(
    orgId: string,
    opts?: { statuses?: string[]; q?: string; limit?: number; offset?: number },
  ): Promise<{ members: MemberListRow[]; total: number }> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const statuses = opts?.statuses && opts.statuses.length > 0 ? opts.statuses : ['active', 'suspended'];
    const q = opts?.q?.trim();

    const membershipFilters = [eq(orgMemberships.orgId, orgId), inArray(orgMemberships.status, statuses)];
    if (q) {
      const needle = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const identityFilter = or(ilike(accounts.email, needle), ilike(accounts.displayName, needle));
      if (identityFilter) {
        membershipFilters.push(identityFilter);
      }
    }
    const where = and(...membershipFilters);

    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          accountId: orgMemberships.accountId,
          role: orgMemberships.role,
          status: orgMemberships.status,
          invitedBy: orgMemberships.invitedBy,
          lastActiveAt: orgMemberships.lastActiveAt,
          suspendedAt: orgMemberships.suspendedAt,
          suspendedBy: orgMemberships.suspendedBy,
          createdAt: orgMemberships.createdAt,
          email: accounts.email,
          displayName: accounts.displayName,
          mfaLevel: accounts.mfaLevel,
          emailVerifiedAt: accounts.emailVerifiedAt,
          lastLoginAt: accounts.lastLoginAt,
        })
        .from(orgMemberships)
        .innerJoin(accounts, eq(accounts.id, orgMemberships.accountId))
        .where(where)
        .orderBy(asc(orgMemberships.createdAt))
        .limit(limit)
        .offset(offset),
    );
    const totals = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ total: count() })
        .from(orgMemberships)
        .innerJoin(accounts, eq(accounts.id, orgMemberships.accountId))
        .where(where),
    );

    const groupRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ accountId: orgGroupMembers.accountId, groupId: orgGroups.id, groupName: orgGroups.name })
        .from(orgGroupMembers)
        .innerJoin(orgGroups, eq(orgGroups.id, orgGroupMembers.groupId))
        .where(eq(orgGroupMembers.orgId, orgId)),
    );
    const groupsByAccount = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of groupRows) {
      const list = groupsByAccount.get(row.accountId) ?? [];
      list.push({ id: row.groupId, name: row.groupName });
      groupsByAccount.set(row.accountId, list);
    }

    return {
      members: rows.map((row) => ({
        accountId: row.accountId,
        email: row.email,
        displayName: row.displayName,
        role: row.role as OrgRole,
        status: row.status,
        mfaLevel: row.mfaLevel,
        emailVerified: row.emailVerifiedAt !== null,
        lastLoginAt: row.lastLoginAt ?? null,
        memberSince: row.createdAt,
        lastActiveAt: row.lastActiveAt ?? null,
        invitedBy: row.invitedBy ?? null,
        suspendedAt: row.suspendedAt ?? null,
        suspendedBy: row.suspendedBy ?? null,
        groups: groupsByAccount.get(row.accountId) ?? [],
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  async getMember(orgId: string, accountId: string): Promise<MembershipRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))).limit(1),
    );
    if (!rows[0] || rows[0].status === 'removed') {
      return null;
    }
    return rows[0];
  }

  async listActiveOwners(orgId: string): Promise<MembershipRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner'), eq(orgMemberships.status, 'active'))),
    );
  }

  async addMember(input: {
    orgId: string;
    accountId: string;
    role: OrgRole;
    invitedBy: string;
  }): Promise<MembershipRow> {
    const now = new Date().toISOString();
    const inserted = await this.db.withOrg(input.orgId, async (tx) => {
      // AUTH-4.1 (auth_plan.md D5): the seat wall lives at the moment
      // membership is granted, inside the granting transaction. Locking the
      // seat-bearing entitlement rows FOR UPDATE serializes redemptions per
      // org — two concurrent invites cannot both read "under the limit" and
      // both insert; the second parks on the lock and re-counts after the
      // first commits. Orgs without a seat-bearing entitlement are exactly
      // the orgs with no cap, so the lock is moot there. Service accounts
      // never pass through here (they are not seats); owners are never
      // granted via this path (INVITABLE_ROLES).
      if (env.ENTITLEMENTS__SEAT_ENFORCEMENT) {
        const seatRows = await tx
          .select({ product: productEntitlements.product, seats: productEntitlements.seats, status: productEntitlements.status })
          .from(productEntitlements)
          .where(and(eq(productEntitlements.orgId, input.orgId), sql`${productEntitlements.seats} IS NOT NULL`))
          .for('update');
        const capped = seatRows.filter((row) => row.status === 'trial' || row.status === 'active' || row.status === 'past_due');
        if (capped.length > 0) {
          const current = await tx
            .select({ status: orgMemberships.status })
            .from(orgMemberships)
            .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId)))
            .limit(1);
          const consumesSeat = current[0]?.status !== 'active'; // re-activating an existing member consumes no additional seat
          if (consumesSeat) {
            const actives = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(orgMemberships)
              .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.status, 'active')));
            const activeCount = Number(actives[0]?.n ?? 0);
            const limiting = capped.find((row) => activeCount >= (row.seats ?? 0));
            if (limiting) {
              throw ApiError.seatLimitReached(limiting.product);
            }
          }
        }
      }
      await assertCapacityTx(tx, input.orgId);
      return tx
        .insert(orgMemberships)
        .values({ orgId: input.orgId, accountId: input.accountId, role: input.role, invitedBy: input.invitedBy })
        .onConflictDoUpdate({
          target: [orgMemberships.accountId, orgMemberships.orgId],
          set: { role: input.role, status: 'active', updatedAt: now },
        })
        .returning();
    });
    return inserted[0];
  }

  async setRole(orgId: string, accountId: string, role: OrgRole): Promise<void> {
    try {
      await this.db.withOrg(orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ role, updatedAt: new Date().toISOString() })
          .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))),
      );
    } catch (err) {
      throw translateOwnerInvariant(err);
    }
  }

  async suspendMember(orgId: string, accountId: string, suspendedBy: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'suspended', suspendedAt: now, suspendedBy, updatedAt: now })
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))),
    );
  }

  async reactivateMember(orgId: string, accountId: string): Promise<void> {
    try {
      await this.db.withOrg(orgId, (tx) =>
        tx
          .update(orgMemberships)
          .set({ status: 'active', updatedAt: new Date().toISOString() })
          .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))),
      );
    } catch (err) {
      // Defense-in-depth: suspended owners are impossible today (suspendMember
      // refuses owners), so reactivation cannot create a second owner — but if
      // that ever changes, the index (0044) catches it here.
      throw translateOwnerInvariant(err);
    }
  }

  async removeMembership(orgId: string, accountId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(orgMemberships)
        .set({ status: 'removed', updatedAt: new Date().toISOString() })
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId)));
      // Group memberships follow the member out.
      await tx.delete(orgGroupMembers).where(and(eq(orgGroupMembers.orgId, orgId), eq(orgGroupMembers.accountId, accountId)));
    });
  }

  async getRole(accountId: string, orgId: string): Promise<OrgRole | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ role: orgMemberships.role, status: orgMemberships.status, lastActiveAt: orgMemberships.lastActiveAt })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.orgId, orgId)))
        .limit(1),
    );
    const row = rows[0];
    if (!row || row.status !== 'active') {
      return null;
    }
    void this.touchLastActive(orgId, accountId, row.lastActiveAt ?? null);
    return row.role as OrgRole;
  }

  private async touchLastActive(orgId: string, accountId: string, lastActiveAt: string | null): Promise<void> {
    const stale =
      lastActiveAt === null || Math.abs(Date.now() - Date.parse(lastActiveAt)) > LAST_ACTIVE_WRITE_THRESHOLD_MS;
    if (!stale) {
      return;
    }
    await this.db
      .withOrg(orgId, (tx) => tx.update(orgMemberships).set({ lastActiveAt: new Date().toISOString() }).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))))
      .catch(() => undefined);
  }

  async listForAccount(accountId: string): Promise<MembershipRow[]> {
    // Justification (withBypass): the account's memberships span orgs by
    // definition; the query filters account_id explicitly.
    return this.db.withBypass((tx) =>
      tx.select().from(orgMemberships).where(and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.status, 'active'))),
    );
  }

  async summary(orgId: string): Promise<MembershipSummary> {
    const byStatus = await this.db.withOrg(orgId, (tx) =>
      tx.select({ status: orgMemberships.status, n: count() }).from(orgMemberships).where(eq(orgMemberships.orgId, orgId)).groupBy(orgMemberships.status),
    );
    const statusCount = new Map(byStatus.map((r) => [r.status, Number(r.n)]));
    const active = statusCount.get('active') ?? 0;
    const suspended = statusCount.get('suspended') ?? 0;

    const pending = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ n: count() })
        .from(orgInvites)
        .where(
          and(
            eq(orgInvites.orgId, orgId),
            sql`${orgInvites.acceptedAt} is null`,
            sql`${orgInvites.revokedAt} is null`,
            sql`${orgInvites.expiresAt} > now()`,
          ),
        ),
    );
    const serviceAccountsByStatus = await this.db.withOrg(orgId, (tx) =>
      tx.select({ status: orgServiceAccounts.status, n: count() }).from(orgServiceAccounts).where(eq(orgServiceAccounts.orgId, orgId)).groupBy(orgServiceAccounts.status),
    );
    const saCount = new Map(serviceAccountsByStatus.map((r) => [r.status, Number(r.n)]));
    const groupRows = await this.db.withOrg(orgId, (tx) => tx.select({ n: count() }).from(orgGroups).where(eq(orgGroups.orgId, orgId)));
    const entitlementRows = await this.db.withOrg(orgId, (tx) =>
      tx.select({ product: productEntitlements.product, plan: productEntitlements.plan, seats: productEntitlements.seats, status: productEntitlements.status }).from(productEntitlements).where(eq(productEntitlements.orgId, orgId)),
    );

    return {
      members: { total: active + suspended, active, suspended },
      pendingInvites: Number(pending[0]?.n ?? 0),
      serviceAccounts: { total: (saCount.get('active') ?? 0) + (saCount.get('disabled') ?? 0), active: saCount.get('active') ?? 0 },
      groups: Number(groupRows[0]?.n ?? 0),
      seats: entitlementRows.map((row) => ({
        product: row.product,
        plan: row.plan,
        seats: row.seats ?? null,
        activeMembers: active,
        utilization: row.seats && row.seats > 0 ? Math.round((active / row.seats) * 100) / 100 : null,
        state: row.status,
      })),
    };
  }
}

/** Hard cap on org size (abuse posture, not billing — seats are billing's). */
async function assertCapacityTx(tx: NodePgDatabase, orgId: string): Promise<void> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, 'active')));
  if (Number(rows[0]?.n ?? 0) >= env.ORG_MAX_MEMBERS) {
    throw ApiError.conflict(`organization is at its member cap (${env.ORG_MAX_MEMBERS})`);
  }
}
