import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { AccountsService } from '../identity/accounts.service';
import { EntitlementsService } from './entitlements.service';
import { MembershipsService } from './memberships.service';
import { OrgGroupsService } from './org-groups.service';
import { OrgServiceAccountsService } from './org-service-accounts.service';
import { getOrgBrief, getOrgName } from './org-info';
import {
  INVITE_REPOSITORY,
  ORG_AUDIT_REPOSITORY,
  ORG_INFO_REPOSITORY,
  ORG_LIFECYCLE_REPOSITORY,
  PROJECT_REPOSITORY,
} from './repositories/repository-tokens';
import type { IOrgLifecycleRepository } from './repositories/org-lifecycle.repository';
import type { IOrgInfoRepository } from './repositories/org-info.repository';
import type { IInviteRepository } from './repositories/invite.repository';
import type { IProjectRepository } from './repositories/project.repository';
import type { IOrgAuditRepository } from './repositories/org-audit.repository';

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
 * TRANSFER (owner + step-up): one transaction, demote-then-promote (AUTH-1.6)
 * — the partial unique index uq_one_active_owner_per_org (drizzle/0044) is the
 * database backstop for the exactly-one-owner invariant; both parties
 * notified + audited.
 *
 * Persistence lives behind the repository ports (selected by `DB_PROVIDER`
 * in `OrganizationsModule`); this service keeps validation, audit replay,
 * event emission, and notification emails.
 */
@Injectable()
export class OrgLifecycleService {
  private static readonly logger = new Logger(OrgLifecycleService.name);

  constructor(
    @Inject(ORG_LIFECYCLE_REPOSITORY) private readonly lifecycle: IOrgLifecycleRepository,
    @Inject(ORG_INFO_REPOSITORY) private readonly orgInfo: IOrgInfoRepository,
    @Inject(INVITE_REPOSITORY) private readonly invitesRepo: IInviteRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projectsRepo: IProjectRepository,
    @Inject(ORG_AUDIT_REPOSITORY) private readonly orgAudit: IOrgAuditRepository,
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
    const existing = await this.lifecycle.getDeletion(input.orgId);
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
    await this.lifecycle.requestDeletion({ orgId: input.orgId, requestedBy: input.actorId, scheduledPurgeAt });

    // Immediate effects: entitlements expire (each audited by the service
    // through EntitlementsService.transition), invites revoke, org keys
    // revoke, service-account tokens void.
    const entitlementRows = await this.entitlements.listForOrg(input.orgId);
    for (const row of entitlementRows) {
      if (row.status !== 'expired') {
        await this.entitlements
          .transition({ orgId: input.orgId, product: row.product, target: 'expired', actorId: input.actorId, source: 'org.deletion' })
          .catch((err) => OrgLifecycleService.logger.warn(`entitlement expiry failed for ${row.product}: ${(err as Error).message}`));
      }
    }
    await this.lifecycle.revokeInvitesForOrg(input.orgId);
    // api_keys is Python-owned without RLS — the repository carries the
    // explicit tenant filter (the documented dual-write seam).
    await this.lifecycle.revokeApiKeysForOrg(input.orgId);
    // Service-account tokens die with the request (identities linger until
    // purge so the inventory stays inspectable during grace).
    await this.lifecycle.voidServiceAccountTokensForOrg(input.orgId);

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
      org_name: await getOrgName(this.orgInfo, input.orgId),
      purge_date: scheduledPurgeAt.slice(0, 10),
    });
    return { scheduled_purge_at: scheduledPurgeAt };
  }

  async cancelDeletion(input: { orgId: string; actorId: string }): Promise<void> {
    const row = await this.lifecycle.getDeletion(input.orgId);
    if (!row || row.status !== 'requested') {
      throw ApiError.notFound('pending org deletion');
    }
    await this.lifecycle.cancelDeletion(input.orgId);
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
      org_name: await getOrgName(this.orgInfo, input.orgId),
    });
  }

  async deletionStatus(orgId: string): Promise<{ status: string; scheduled_purge_at: string | null } | null> {
    const row = await this.lifecycle.getDeletion(orgId);
    return row ? { status: row.status, scheduled_purge_at: row.scheduledPurgeAt } : null;
  }

  /**
   * The grace-window export: everything the owner is entitled to take away,
   * in one JSON payload (members, invites, projects, groups, service
   * accounts sans hashes, entitlements, the trailing audit window).
   */
  async exportOrgData(input: { orgId: string; actorId: string }): Promise<Record<string, unknown>> {
    const brief = await getOrgBrief(this.orgInfo, input.orgId);
    if (!brief) {
      throw ApiError.notFound('organization');
    }
    const [members, invites, projectRows, groupRows, serviceAccountViews, entitlementViews, auditPage] = await Promise.all([
      this.lifecycle.listMembershipRows(input.orgId),
      this.invitesRepo.listInvites(input.orgId),
      this.projectsRepo.listProjects(input.orgId, true),
      this.groups.list(input.orgId),
      this.serviceAccounts.list(input.orgId),
      this.entitlements.listForOrg(input.orgId),
      this.orgAudit.query(input.orgId, { limit: 1000, order: 'desc' }),
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
      audit: auditPage.events,
    };
  }

  /** The daily purge pass: erase due orgs. Returns purged org ids (ops evidence). */
  async purgeDue(): Promise<string[]> {
    const dueOrgIds = await this.lifecycle.listDeletionsDue(new Date().toISOString());
    const purged: string[] = [];
    for (const orgId of dueOrgIds) {
      try {
        await this.purge(orgId);
        purged.push(orgId);
      } catch (err) {
        OrgLifecycleService.logger.error(`purge failed for org ${orgId}: ${(err as Error).message}`);
      }
    }
    return purged;
  }

  private async purge(orgId: string): Promise<void> {
    await this.audit.add({
      action: 'org.purge_started',
      resourceType: 'tenant',
      resourceId: orgId,
      actorType: 'system',
      tenantId: orgId,
      details: {},
    });

    // Engine-owned org data erased in the schema order, the Python-owned
    // tenants row marked deleted (NOT removed), the deletion row flipped to
    // 'purged' — one repository unit; per-table counts are ops evidence.
    const counts = await this.lifecycle.purgeOrgData(orgId);
    OrgLifecycleService.logger.debug(`purge counts for org ${orgId}: ${JSON.stringify(counts)}`);

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
    // AUTH-1.6 (auth_plan.md D2): ONE transaction, demote-then-promote —
    // owned by the repository (the only ordering that never momentarily
    // holds two active owners). Direct UPDATEs, not changeRole — its
    // owner-preservation check would trip mid-transfer by design.
    await this.lifecycle.transferOwnership({
      orgId: input.orgId,
      currentOwnerAccountId: input.actorId,
      newOwnerAccountId: input.targetAccountId,
    });

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
            org_name: await getOrgName(this.orgInfo, input.orgId),
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
}
