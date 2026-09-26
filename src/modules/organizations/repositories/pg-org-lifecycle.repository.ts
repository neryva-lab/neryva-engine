import { and, eq, lte, sql, type SQL } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { legacyApiKeys, legacyTenants } from '../../../common/infra/db/legacy-schema';
import { orgDeletions, orgInvites, orgMemberships, orgServiceAccounts, productEntitlements, projects } from '../schema';
import type { DeletionRow, IOrgLifecycleRepository, MembershipRow } from './org-lifecycle.repository';

/**
 * PostgreSQL implementation of `IOrgLifecycleRepository` (P3).
 *
 * Mechanical move of the `OrgLifecycleService` persistence units — every
 * statement is the service's original SQL/drizzle, unchanged in order and
 * predicate. `withOrg` / `withBypass` / `db.root` usage mirrors the
 * service's original context choices exactly.
 *
 * What stays OUT (still the service's job): owner re-checks, audit writes,
 * event emission, owner emails, the per-product entitlement-expiry replay
 * (via `EntitlementsService`).
 */
export class PgOrgLifecycleRepository implements IOrgLifecycleRepository {
  constructor(private readonly db: DbService) {}

  async transferOwnership(input: { orgId: string; currentOwnerAccountId: string; newOwnerAccountId: string }): Promise<void> {
    // AUTH-1.6 (auth_plan.md D2): ONE transaction, demote-then-promote — the
    // only ordering that never momentarily holds two active owners, so the
    // partial unique index uq_one_active_owner_per_org (drizzle/0044) holds at
    // every statement boundary. A crash rolls the whole TX back; a concurrent
    // transfer loses at its promote statement with 23505. Direct UPDATEs, not
    // changeRole — its owner-preservation check would trip mid-transfer by
    // design. The post-condition re-check is defense-in-depth.
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, async (tx) => {
      const demoted = await tx
        .update(orgMemberships)
        .set({ role: 'admin', updatedAt: now })
        .where(
          and(
            eq(orgMemberships.orgId, input.orgId),
            eq(orgMemberships.accountId, input.currentOwnerAccountId),
            eq(orgMemberships.role, 'owner'),
            eq(orgMemberships.status, 'active'),
          ),
        )
        .returning({ id: orgMemberships.id });
      if (demoted.length === 0) {
        throw ApiError.forbidden('only the current owner may transfer ownership');
      }
      const promoted = await tx
        .update(orgMemberships)
        .set({ role: 'owner', updatedAt: now })
        .where(
          and(
            eq(orgMemberships.orgId, input.orgId),
            eq(orgMemberships.accountId, input.newOwnerAccountId),
            eq(orgMemberships.status, 'active'),
          ),
        )
        .returning({ id: orgMemberships.id });
      if (promoted.length === 0) {
        throw ApiError.notFound('target member (must be an active member of the org)');
      }
      const owners = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.role, 'owner'), eq(orgMemberships.status, 'active')));
      if (Number(owners[0]?.n ?? 0) !== 1) {
        throw ApiError.conflict('ownership transfer must leave exactly one active owner');
      }
    });
  }

  async getDeletion(orgId: string): Promise<DeletionRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgDeletions).where(eq(orgDeletions.orgId, orgId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async requestDeletion(input: { orgId: string; requestedBy: string; scheduledPurgeAt: string }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgDeletions)
        .values({ orgId: input.orgId, requestedBy: input.requestedBy, status: 'requested', scheduledPurgeAt: input.scheduledPurgeAt })
        .onConflictDoUpdate({
          target: orgDeletions.orgId,
          set: {
            status: 'requested',
            requestedBy: input.requestedBy,
            scheduledPurgeAt: input.scheduledPurgeAt,
            cancelledAt: null,
            purgedAt: null,
            updatedAt: now,
          },
        }),
    );
  }

  async cancelDeletion(orgId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withOrg(orgId, (tx) =>
      tx.update(orgDeletions).set({ status: 'cancelled', cancelledAt: now, updatedAt: now }).where(eq(orgDeletions.orgId, orgId)),
    );
  }

  async listDeletionsDue(nowIso: string): Promise<string[]> {
    const due = await this.db.withBypass((tx) =>
      // Justification (withBypass): the purge scheduler scans across orgs —
      // an explicitly administrative, cross-tenant read.
      tx
        .select({ orgId: orgDeletions.orgId })
        .from(orgDeletions)
        .where(and(eq(orgDeletions.status, 'requested'), lte(orgDeletions.scheduledPurgeAt, nowIso))),
    );
    return due.map((row) => row.orgId);
  }

  async revokeInvitesForOrg(orgId: string): Promise<number> {
    const now = new Date().toISOString();
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgInvites)
        .set({ revokedAt: now })
        .where(and(eq(orgInvites.orgId, orgId), sql`${orgInvites.revokedAt} is null`))
        .returning({ id: orgInvites.id }),
    );
    return rows.length;
  }

  async voidServiceAccountTokensForOrg(orgId: string): Promise<number> {
    const now = new Date().toISOString();
    // Idempotent "voided count": only rows that still hold a token are
    // touched, mirroring revokeInvitesForOrg's `revokedAt is null` guard and
    // the mongo lane's modifiedCount. A second call voids nothing → 0.
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgServiceAccounts)
        .set({ tokenHash: null, tokenPrefix: null, tokenExpiresAt: null, updatedAt: now })
        .where(and(eq(orgServiceAccounts.orgId, orgId), sql`${orgServiceAccounts.tokenHash} is not null`))
        .returning({ id: orgServiceAccounts.id }),
    );
    return rows.length;
  }

  async revokeApiKeysForOrg(orgId: string): Promise<number> {
    const now = new Date().toISOString();
    // api_keys is Python-owned without RLS — explicit tenant filter (the
    // documented dual-write seam the keys module already opened).
    const rows = await this.db.root
      .update(legacyApiKeys)
      .set({ revoked: true, updated_at: now })
      .where(and(eq(legacyApiKeys.tenant_id, orgId), eq(legacyApiKeys.revoked, false)))
      .returning({ id: legacyApiKeys.id });
    return rows.length;
  }

  async listMembershipRows(orgId: string): Promise<MembershipRow[]> {
    return this.db.withOrg(orgId, (tx) => tx.select().from(orgMemberships).where(eq(orgMemberships.orgId, orgId)));
  }

  async purgeOrgData(orgId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    // Engine-owned org data, per schema — RLS context per org, the
    // service's original delete order.
    await this.db.withOrg(orgId, async (tx) => {
      const deletes: Array<[string, SQL]> = [
        ['studio_project_keys', sql`delete from studio_project_keys where org_id = ${orgId}`],
        ['product_deployment.deployment_events', sql`delete from product_deployment.deployment_events where org_id = ${orgId}`],
        ['product_deployment.deployments', sql`delete from product_deployment.deployments where org_id = ${orgId}`],
        ['product_deployment.pipeline_stages', sql`delete from product_deployment.pipeline_stages where org_id = ${orgId}`],
        ['product_deployment.pipelines', sql`delete from product_deployment.pipelines where org_id = ${orgId}`],
        ['product_deployment.secrets', sql`delete from product_deployment.secrets where org_id = ${orgId}`],
        ['product_deployment.environments', sql`delete from product_deployment.environments where org_id = ${orgId}`],
        ['published_configs', sql`delete from published_configs where org_id = ${orgId}`],
        ['webhook_deliveries', sql`delete from webhook_deliveries where org_id = ${orgId}`],
        ['webhooks', sql`delete from webhooks where org_id = ${orgId}`],
        ['notifications', sql`delete from notifications where org_id = ${orgId}`],
        ['org_group_members', sql`delete from org_group_members where org_id = ${orgId}`],
        ['org_groups', sql`delete from org_groups where org_id = ${orgId}`],
        ['org_service_accounts', sql`delete from org_service_accounts where org_id = ${orgId}`],
        ['org_settings', sql`delete from org_settings where org_id = ${orgId}`],
        ['projects', sql`delete from projects where org_id = ${orgId}`],
        ['org_invites', sql`delete from org_invites where org_id = ${orgId}`],
        ['org_memberships', sql`delete from org_memberships where org_id = ${orgId}`],
        ['product_entitlements', sql`delete from product_entitlements where org_id = ${orgId}`],
      ];
      for (const [name, stmt] of deletes) {
        const result = await tx.execute(stmt);
        counts[name] = result.rowCount ?? 0;
      }
    });

    // The tenants row is Python-owned: mark deleted via features jsonb
    // (documented seam — same INSERT-seam family the ownership map tracks).
    const now = new Date().toISOString();
    const marked = await this.db.root
      .update(legacyTenants)
      .set({
        features: sql`jsonb_set(coalesce(features, '{}'::jsonb), '{deleted}', 'true'::jsonb, true)`,
        updated_at: now,
      })
      .where(eq(legacyTenants.id, orgId));
    counts['tenants.marked_deleted'] = marked.rowCount ?? 0;

    await this.db.withOrg(orgId, (tx) =>
      tx.update(orgDeletions).set({ status: 'purged', purgedAt: now, updatedAt: now }).where(eq(orgDeletions.orgId, orgId)),
    );
    return counts;
  }
}
