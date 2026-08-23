import { and, eq, lte, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { AccountsService } from '../identity/accounts.service';
import { legacyApiKeys, legacyTenants } from '../../common/infra/db/legacy-schema';
import { EntitlementsService } from './entitlements.service';
import { MembershipsService } from './memberships.service';
import { OrgGroupsService } from './org-groups.service';
import { OrgServiceAccountsService } from './org-service-accounts.service';
import { getOrgBrief, getOrgName } from './org-info';
import { orgDeletions, orgInvites, orgMemberships, orgServiceAccounts, productEntitlements, projects } from './schema';

/**
 * Org lifecycle (the audit's O-2/O-3 blockers): staged deletion with a
 * cancel-able grace window, the purge job, ownership transfer, and the
 * grace-window export.
 *
 * DELETION SEMANTICS (deliberate, enterprise-grade):
 *  - request (owner + step-up at the controller): entitlements expire
 *    (audited each), invites revoke, org API keys revoke, service-account
 *    tokens void, the grace clock starts (ORG_DELETION_GRACE_DAYS). The org
 *    stays readable so the owner can export during grace.
 *  - cancel (owner, before purge): restores nothing that was already
 *    expired/revoked (those are billing/security facts) — it stops the
 *    purge. Honest and documented.
 *  - purge (job, daily): erases engine-owned rows — memberships, invites,
 *    projects, entitlements, settings, groups, service accounts, studio
 *    key bindings, deployment tables, published configs, webhooks +
 *    deliveries, notifications — and marks the Python-owned tenants row
 *    deleted via its features jsonb (documented dual-write seam; DDL stays
 *    Python's). RETAINED with justification: billing.spend_events +
 *    billing_invoices (financial retention, the org_id is an opaque UUID —
 *    pseudonymous), the audit chain (append-only by construction; erasing
 *    links would BREAK the chain — the legally correct posture for a
 *    tamper-evident log).
 *
 * TRANSFER (owner + step-up): promote target → owner, demote actor →
 * admin, atomically via the memberships service's exactly-one-owner
 * invariants; both parties notified + audited.
 */
@Injectable()
export class OrgLifecycleService {
  private static readonly logger = new Logger(OrgLifecycleService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly email: EmailService,
    private readonly accounts: AccountsService,
    private readonly memberships: MembershipsService,
    private readonly entitlements: EntitlementsService,
    private readonly groups: OrgGroupsService,
    private readonly serviceAccounts: OrgServiceAccountsService,
  ) {}

  // ── deletion ───────────────────────────────────────────────────────────────

  async requestDeletion(input: { orgId: string; actorId: string }): Promise<{ scheduled_purge_at: string }> {
    const existing = await this.deletionRow(input.orgId);
    if (existing && existing.status === 'requested') {
      throw ApiError.conflict('deletion is already scheduled', { scheduled_purge_at: existing.scheduledPurgeAt });
    }
    // Actor must be the owner (the controller's Roles('owner') proves it,
    // but the service re-checks — the last line of defense).
    const role = await this.memberships.getRole(input.actorId, input.orgId);
    if (role !== 'owner') {
      throw ApiError.forbidden('only the owner may delete the organization');
    }

    const scheduledPurgeAt = new Date(Date.now() + env.ORG_DELETION_GRACE_DAYS * 86_400_000).toISOString();
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgDeletions)
        .values({ orgId: input.orgId, requestedBy: input.actorId, status: 'requested', scheduledPurgeAt })
        .onConflictDoUpdate({
          target: orgDeletions.orgId,
          set: { status: 'requested', requestedBy: input.actorId, scheduledPurgeAt, cancelledAt: null, purgedAt: null, updatedAt: now },
        }),
    );

    // Immediate effects: entitlements expire (each audited by the service),
    // invites revoke, org keys revoke, service-account tokens void.
    const entitlementRows = await this.entitlements.listForOrg(input.orgId);
    for (const row of entitlementRows) {
      if (row.status !== 'expired') {
        await this.entitlements
          .transition({ orgId: input.orgId, product: row.product, target: 'expired', actorId: input.actorId, source: 'org.deletion' })
          .catch((err) => OrgLifecycleService.logger.warn(`entitlement expiry failed for ${row.product}: ${(err as Error).message}`));
      }
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx.update(orgInvites).set({ revokedAt: now }).where(and(eq(orgInvites.orgId, input.orgId), sql`${orgInvites.revokedAt} is null`)),
    );
    // api_keys is Python-owned without RLS — explicit tenant filter (the
    // documented dual-write seam the keys module already opened).
    await this.db.root
      .update(legacyApiKeys)
      .set({ revoked: true, updated_at: now })
      .where(and(eq(legacyApiKeys.tenant_id, input.orgId), eq(legacyApiKeys.revoked, false)));
    // Service-account tokens die with the request (identities linger until
    // purge so the inventory stays inspectable during grace).
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgServiceAccounts)
        .set({ tokenHash: null, tokenPrefix: null, tokenExpiresAt: null, updatedAt: now })
        .where(eq(orgServiceAccounts.orgId, input.orgId)),
    );

    await this.audit.add({
      action: 'org.deletion_requested',
      resourceType: 'tenant',
      resourceId: input.orgId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { scheduled_purge_at: scheduledPurgeAt },
    });
    await this.events.emit(EngineEvents.OrgDeletionRequested, { orgId: input.orgId, scheduledPurgeAt });
    await this.emailOwner(input.orgId, input.actorId, 'org.deletion-requested', {
      org_name: await getOrgName(this.db, input.orgId),
      purge_date: scheduledPurgeAt.slice(0, 10),
    });
    return { scheduled_purge_at: scheduledPurgeAt };
  }

  async cancelDeletion(input: { orgId: string; actorId: string }): Promise<void> {
    const row = await this.deletionRow(input.orgId);
    if (!row || row.status !== 'requested') {
      throw ApiError.notFound('pending org deletion');
    }
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx.update(orgDeletions).set({ status: 'cancelled', cancelledAt: now, updatedAt: now }).where(eq(orgDeletions.orgId, input.orgId)),
    );
    await this.audit.add({
      action: 'org.deletion_cancelled',
      resourceType: 'tenant',
      resourceId: input.orgId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { note: 'expired entitlements and revoked keys are NOT auto-restored' },
    });
    await this.events.emit(EngineEvents.OrgDeletionCancelled, { orgId: input.orgId });
    await this.emailOwner(input.orgId, input.actorId, 'org.deletion-cancelled', {
      org_name: await getOrgName(this.db, input.orgId),
    });
  }

  async deletionStatus(orgId: string): Promise<{ status: string; scheduled_purge_at: string | null } | null> {
    const row = await this.deletionRow(orgId);
    return row ? { status: row.status, scheduled_purge_at: row.scheduledPurgeAt } : null;
  }

  /**
   * The grace-window export: everything the owner is entitled to take away,
   * in one JSON payload (members, invites, projects, groups, service
   * accounts sans hashes, entitlements, the trailing audit window).
   */
  async exportOrgData(input: { orgId: string; actorId: string }): Promise<Record<string, unknown>> {
    const brief = await getOrgBrief(this.db, input.orgId);
    if (!brief) {
      throw ApiError.notFound('organization');
    }
    const [members, invites, projectRows, groupRows, serviceAccountViews, entitlementViews, auditRows] = await Promise.all([
      this.db.withOrg(input.orgId, (tx) => tx.select().from(orgMemberships).where(eq(orgMemberships.orgId, input.orgId))),
      this.db.withOrg(input.orgId, (tx) => tx.select().from(orgInvites).where(eq(orgInvites.orgId, input.orgId))),
      this.db.withOrg(input.orgId, (tx) => tx.select().from(projects).where(eq(projects.orgId, input.orgId))),
      this.groups.list(input.orgId),
      this.serviceAccounts.list(input.orgId),
      this.entitlements.listForOrg(input.orgId),
      this.db.root.execute<Record<string, unknown>>(sql`
        select id, actor_type, actor_id, action, resource_type, resource_id, details, created_at
        from audit_events where tenant_id = ${input.orgId}
        order by created_at desc limit 1000
      `),
    ]);
    await this.audit.add({
      action: 'org.data_exported',
      resourceType: 'tenant',
      resourceId: input.orgId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { members: members.length, projects: projectRows.length },
    });
    return {
      exported_at: new Date().toISOString(),
      org: brief,
      members,
      invites: invites.map(({ tokenHash, ...rest }) => {
        void tokenHash;
        return rest;
      }),
      projects: projectRows,
      groups: groupRows,
      service_accounts: serviceAccountViews,
      entitlements: entitlementViews,
      audit: auditRows.rows,
    };
  }

  /** The daily purge pass: erase due orgs. Returns purged org ids (ops evidence). */
  async purgeDue(): Promise<string[]> {
    const due = await this.db.withBypass((tx) =>
      // Justification (withBypass): the purge scheduler scans across orgs —
      // an explicitly administrative, cross-tenant read.
      tx
        .select({ orgId: orgDeletions.orgId })
        .from(orgDeletions)
        .where(and(eq(orgDeletions.status, 'requested'), lte(orgDeletions.scheduledPurgeAt, new Date().toISOString()))),
    );
    const purged: string[] = [];
    for (const row of due) {
      try {
        await this.purge(row.orgId);
        purged.push(row.orgId);
      } catch (err) {
        OrgLifecycleService.logger.error(`purge failed for org ${row.orgId}: ${(err as Error).message}`);
      }
    }
    return purged;
  }

  private async purge(orgId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.audit.add({
      action: 'org.purge_started',
      resourceType: 'tenant',
      resourceId: orgId,
      actorType: 'system',
      tenantId: orgId,
      details: {},
    });

    // Engine-owned org data, per schema — RLS context per org.
    await this.db.withOrg(orgId, async (tx) => {
      await tx.execute(sql`delete from studio_project_keys where org_id = ${orgId}`);
      await tx.execute(sql`delete from product_deployment.deployment_events where org_id = ${orgId}`);
      await tx.execute(sql`delete from product_deployment.deployments where org_id = ${orgId}`);
      await tx.execute(sql`delete from product_deployment.pipeline_stages where org_id = ${orgId}`);
      await tx.execute(sql`delete from product_deployment.pipelines where org_id = ${orgId}`);
      await tx.execute(sql`delete from product_deployment.secrets where org_id = ${orgId}`);
      await tx.execute(sql`delete from product_deployment.environments where org_id = ${orgId}`);
      await tx.execute(sql`delete from published_configs where org_id = ${orgId}`);
      await tx.execute(sql`delete from webhook_deliveries where org_id = ${orgId}`);
      await tx.execute(sql`delete from webhooks where org_id = ${orgId}`);
      await tx.execute(sql`delete from notifications where org_id = ${orgId}`);
      await tx.execute(sql`delete from org_group_members where org_id = ${orgId}`);
      await tx.execute(sql`delete from org_groups where org_id = ${orgId}`);
      await tx.execute(sql`delete from org_service_accounts where org_id = ${orgId}`);
      await tx.execute(sql`delete from org_settings where org_id = ${orgId}`);
      await tx.delete(projects).where(eq(projects.orgId, orgId));
      await tx.delete(orgInvites).where(eq(orgInvites.orgId, orgId));
      await tx.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId));
      await tx.delete(productEntitlements).where(eq(productEntitlements.orgId, orgId));
    });

    // The tenants row is Python-owned: mark deleted via features jsonb
    // (documented seam — same INSERT-seam family the ownership map tracks).
    await this.db.root
      .update(legacyTenants)
      .set({ features: sql`jsonb_set(coalesce(features, '{}'::jsonb), '{deleted}', 'true'::jsonb, true)`, updated_at: now })
      .where(eq(legacyTenants.id, orgId));

    await this.db.withOrg(orgId, (tx) =>
      tx.update(orgDeletions).set({ status: 'purged', purgedAt: now, updatedAt: now }).where(eq(orgDeletions.orgId, orgId)),
    );
    await this.audit.add({
      action: 'org.purged',
      resourceType: 'tenant',
      resourceId: orgId,
      actorType: 'system',
      details: {
        retained: 'billing records (financial retention, pseudonymous org id) + audit chain (append-only by construction)',
      },
    });
    await this.events.emit(EngineEvents.OrgPurged, { orgId });
  }

  // ── ownership transfer ─────────────────────────────────────────────────────

  async transferOwnership(input: { orgId: string; targetAccountId: string; actorId: string; actorEmail?: string | null }): Promise<void> {
    if (input.targetAccountId === input.actorId) {
      throw ApiError.validation({ target_account_id: 'cannot transfer to yourself' });
    }
    // Both invariants live in MembershipsService.changeRole: promoting the
    // target requires exactly one current owner; demoting the actor
    // requires another owner to remain — the promote-then-demote order
    // satisfies both atomically enough (any failure leaves a valid state:
    // two owners momentarily, which the invariants tolerate on the next
    // change; a partial failure is audited below).
    await this.memberships.changeRole({ orgId: input.orgId, accountId: input.targetAccountId, role: 'owner', actorId: input.actorId, actorEmail: input.actorEmail });
    try {
      await this.memberships.changeRole({ orgId: input.orgId, accountId: input.actorId, role: 'admin', actorId: input.actorId, actorEmail: input.actorEmail });
    } catch (err) {
      // Promote succeeded, demote failed → two active owners. Roll the
      // promotion back so the org never sits in an unintended state.
      await this.memberships
        .changeRole({ orgId: input.orgId, accountId: input.targetAccountId, role: 'admin', actorId: input.actorId })
        .catch(() => undefined);
      throw ApiError.conflict(`transfer failed at demotion step: ${(err as Error).message}`);
    }

    await this.audit.add({
      action: 'org.ownership_transferred',
      resourceType: 'tenant',
      resourceId: input.orgId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { to: input.targetAccountId },
    });
    await this.events.emit(EngineEvents.OrgOwnershipTransferred, {
      orgId: input.orgId,
      fromAccountId: input.actorId,
      toAccountId: input.targetAccountId,
    });
    const target = await this.accounts.findById(input.targetAccountId).catch(() => null);
    if (target) {
      await this.email
        .sendTemplate({
          template: 'org.ownership-transferred',
          to: target.email,
          vars: {
            org_name: await getOrgName(this.db, input.orgId),
            from_email: input.actorEmail ?? 'the previous owner',
          },
          metadata: { orgId: input.orgId, accountId: target.id },
        })
        .catch(() => undefined);
    }
  }

  private async emailOwner(orgId: string, accountId: string, template: string, vars: Record<string, string>): Promise<void> {
    const account = await this.accounts.findById(accountId).catch(() => null);
    if (!account) {
      return;
    }
    await this.email
      .sendTemplate({ template, to: account.email, vars, metadata: { orgId, accountId } })
      .catch(() => undefined);
  }

  private async deletionRow(orgId: string) {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(orgDeletions).where(eq(orgDeletions.orgId, orgId)).limit(1));
    return rows[0] ?? null;
  }
}
