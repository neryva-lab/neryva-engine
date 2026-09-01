import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { RedisService } from '../../common/infra/redis.service';
import { EmailService } from '../corporate/email/email.service';
import { MembershipsService } from '../organizations/memberships.service';
import { AccountsService } from '../identity/accounts.service';
import { notifications } from './schema';

/**
 * The notification service (gap P-2): the one fan-out every alerting path
 * needs. In-app rows ALWAYS land (durable); email rides on top for
 * warn/error severity (template notification.generic) — and email failure
 * never fails the notification.
 *
 * Wiring model (the coupling discipline): this service subscribes to the
 * ENGINE EVENT BUS — it imports no product/billing module. Emitting
 * modules stay decoupled; this module translates events into human-facing
 * notices:
 *   billing.cost_anomaly          → owner/admin/billing of the org (warn)
 *   entitlement.transitioned      → past_due/suspended/expired → owner/billing (warn/error)
 *   org.ownership_transferred     → both parties (info, email)
 *   org.role_changed              → the member (info)
 *   deployment.failed/rolled_back → the triggering actor if resolvable (warn)
 *   webhook.dead                  → webhook creator org's owner/admin (warn)
 *   org.member_added/suspended/reactivated/removed → the member (in-app;
 *     email already handled by the memberships flow itself — no doubles)
 *   org.invite_created            → the invited account if one exists (info)
 *   org.invite_accepted           → owner/admin of the org (info)
 *   satellite.{quarantined,draining,retired,liveness_lost,
 *              version_floor_violated,config_drift} → the ops team inbox
 *     (platform-plane events — no org/account target exists)
 *   login.failure                 → the account after a threshold of failed
 *     attempts within an hour window (warn, email) — never per-attempt
 *   account.deletion_requested    → the account (info, email)
 *   account.email_changed         → the account (warn)
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private static readonly logger = new Logger(NotificationsService.name);

  /** Failed sign-ins inside one hour that trip ONE security notice. */
  private static readonly LOGIN_FAILURE_ALERT_THRESHOLD = 5;

  constructor(
    private readonly db: DbService,
    private readonly events: EventBus,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly memberships: MembershipsService,
    private readonly accounts: AccountsService,
  ) {}

  onModuleInit(): void {
    this.events.on<{ orgId: string; anomalies: Array<{ product: string; spendUsd: number; day: string }> }>('billing.cost_anomaly', (event) => {
      for (const anomaly of event.anomalies ?? []) {
        void this.notifyOrgRoles(event.orgId, ['owner', 'admin', 'billing'], {
          kind: 'billing.anomaly',
          severity: 'warn',
          title: `Unusual ${anomaly.product} spend detected`,
          body: `Spend on ${anomaly.product} for ${anomaly.day} was $${anomaly.spendUsd.toFixed(2)} — well above the trailing average.`,
          data: { product: anomaly.product, day: anomaly.day },
        });
      }
    });

    this.events.on<{ orgId: string; product: string; from: string; to: string }>(EngineEvents.EntitlementTransitioned, (event) => {
      if (event.to === 'past_due' || event.to === 'suspended' || event.to === 'expired') {
        void this.notifyOrgRoles(event.orgId, ['owner', 'billing'], {
          kind: `entitlement.${event.to}`,
          severity: event.to === 'past_due' ? 'warn' : 'error',
          title: `${event.product} is ${event.to.replace('_', ' ')}`,
          body: event.to === 'past_due' ? 'Payment is required — the product is read-only until the invoice is settled.' : 'The product entitlement is no longer active.',
          data: { product: event.product },
          email: true,
        });
      }
    });

    this.events.on<{ orgId: string; fromAccountId: string; toAccountId: string }>(EngineEvents.OrgOwnershipTransferred, (event) => {
      void this.notifyAccount(event.toAccountId, {
        orgId: event.orgId,
        kind: 'org.ownership_transferred',
        severity: 'info',
        title: 'You are now the organization owner',
        body: 'Ownership was transferred to you. The previous owner is now an admin.',
        data: { org_id: event.orgId },
        email: true,
      });
    });

    this.events.on<{ orgId: string; accountId: string; role: string }>(EngineEvents.OrgRoleChanged, (event) => {
      void this.notifyAccount(event.accountId, {
        orgId: event.orgId,
        kind: 'org.role_changed',
        severity: 'info',
        title: `Your role changed to ${event.role}`,
        body: `Your role in this organization is now ${event.role}.`,
        data: { org_id: event.orgId, role: event.role },
      });
    });

    this.events.on<{ orgId: string; deploymentId?: string }>(EngineEvents.DeploymentFailed, (event) => {
      void this.notifyOrgRoles(event.orgId, ['owner', 'admin', 'developer'], {
        kind: 'deployment.failed',
        severity: 'warn',
        title: 'A deployment failed',
        body: 'A deployment run failed its gates or workflow. Inspect the events log for details.',
        data: { deployment_id: event.deploymentId ?? '', org_id: event.orgId },
      });
    });

    this.events.on<{ orgId: string; deliveryId: string }>(EngineEvents.WebhookDead, (event) => {
      void this.notifyOrgRoles(event.orgId, ['owner', 'admin', 'developer'], {
        kind: 'webhook.dead',
        severity: 'warn',
        title: 'A webhook endpoint went dead',
        body: 'A webhook endpoint failed all delivery attempts and was marked dead. Check the URL or disable the webhook.',
        data: { delivery_id: event.deliveryId, org_id: event.orgId },
      });
    });

    // ── org membership lifecycle (emails already ride the memberships
    // flow itself; here it is the in-app feed only — no doubles) ────────────

    this.events.on<{ orgId: string; accountId: string; role: string }>(EngineEvents.OrgMemberAdded, (event) => {
      void this.notifyAccount(event.accountId, {
        orgId: event.orgId,
        kind: 'org.member_added',
        severity: 'info',
        title: 'You were added to an organization',
        body: `You are now a ${event.role} of this organization.`,
        data: { org_id: event.orgId, role: event.role },
      });
    });

    this.events.on<{ orgId: string; accountId: string }>(EngineEvents.OrgMemberSuspended, (event) => {
      void this.notifyAccount(event.accountId, {
        orgId: event.orgId,
        kind: 'org.member_suspended',
        severity: 'warn',
        title: 'Your organization access was suspended',
        body: 'An administrator suspended your access. Contact them if you believe this is a mistake.',
        data: { org_id: event.orgId },
      });
    });

    this.events.on<{ orgId: string; accountId: string }>(EngineEvents.OrgMemberReactivated, (event) => {
      void this.notifyAccount(event.accountId, {
        orgId: event.orgId,
        kind: 'org.member_reactivated',
        severity: 'info',
        title: 'Your organization access was restored',
        body: 'Your membership was reactivated — welcome back.',
        data: { org_id: event.orgId },
      });
    });

    this.events.on<{ orgId: string; accountId: string; role: string; self?: boolean }>(EngineEvents.OrgMemberRemoved, (event) => {
      if (event.self) {
        return; // you left — no notice to yourself
      }
      void this.notifyAccount(event.accountId, {
        orgId: event.orgId,
        kind: 'org.member_removed',
        severity: 'warn',
        title: 'You were removed from an organization',
        body: `Your ${event.role} access to this organization was revoked.`,
        data: { org_id: event.orgId, role: event.role },
      });
    });

    this.events.on<{ orgId: string; inviteId: string; email: string; role: string }>(EngineEvents.OrgInviteCreated, (event) => {
      // The invite email itself is the invite's channel; the feed row is a
      // convenience for people who ALREADY have an account here.
      void this.accounts
        .findByEmail(event.email.toLowerCase())
        .then((account) =>
          account
            ? this.notifyAccount(account.id, {
                orgId: event.orgId,
                kind: 'org.invite_created',
                severity: 'info',
                title: `You were invited to join an organization as ${event.role}`,
                body: 'Open the link in the invitation email to accept.',
                data: { org_id: event.orgId, invite_id: event.inviteId, role: event.role },
              })
            : undefined,
        )
        .catch(() => undefined);
    });

    this.events.on<{ orgId: string; inviteId: string; accountId: string; role: string }>(EngineEvents.OrgInviteAccepted, (event) => {
      void this.notifyOrgRoles(event.orgId, ['owner', 'admin'], {
        kind: 'org.invite_accepted',
        severity: 'info',
        title: 'A pending invitation was accepted',
        body: `The invitee joined as ${event.role}.`,
        data: { org_id: event.orgId, account_id: event.accountId, role: event.role },
      });
    });

    // ── satellite lifecycle incidents → ops inbox (platform-plane events:
    // no org/account target exists, so there is no in-app feed row) ────────

    this.events.on<{ key: string; reason: string }>(EngineEvents.SatelliteQuarantined, (event) => {
      void this.notifyPlatform({
        kind: 'satellite.quarantined',
        severity: 'error',
        title: `Satellite ${event.key} was quarantined`,
        body: `A satellite was quarantined: ${event.reason}`,
        data: { satellite_key: event.key, reason: event.reason },
      });
    });

    this.events.on<{ key: string }>(EngineEvents.SatelliteDraining, (event) => {
      void this.notifyPlatform({
        kind: 'satellite.draining',
        severity: 'warn',
        title: `Satellite ${event.key} is draining`,
        body: 'A satellite stopped accepting new work for graceful retirement. Confirm this was planned.',
        data: { satellite_key: event.key },
      });
    });

    this.events.on<{ key: string }>(EngineEvents.SatelliteRetired, (event) => {
      void this.notifyPlatform({
        kind: 'satellite.retired',
        severity: 'warn',
        title: `Satellite ${event.key} was retired`,
        body: 'A satellite was retired permanently. It will never accept heartbeats again — register a new key instead.',
        data: { satellite_key: event.key },
      });
    });

    this.events.on<{ key: string; state: string }>(EngineEvents.SatelliteLivenessLost, (event) => {
      void this.notifyPlatform({
        kind: 'satellite.liveness_lost',
        severity: 'error',
        title: `Satellite ${event.key} liveness lost (${event.state})`,
        body: 'Heartbeats stopped arriving and the lease expired twice. The satellite is hard down from the engine’s point of view.',
        data: { satellite_key: event.key, state: event.state },
      });
    });

    this.events.on<{ key: string; reported: string; floor: string }>(EngineEvents.SatelliteVersionFloorViolated, (event) => {
      void this.notifyPlatform({
        kind: 'satellite.version_floor_violated',
        severity: 'warn',
        title: `Satellite ${event.key} reported version below the floor`,
        body: `Reported ${event.reported} against floor ${event.floor}. Quarantine or drain if this was not a rollback.`,
        data: { satellite_key: event.key, reported: event.reported, floor: event.floor },
      });
    });

    this.events.on<{ key: string; unacked: number }>(EngineEvents.SatelliteConfigDrift, (event) => {
      void this.notifyPlatform({
        kind: 'satellite.config_drift',
        severity: 'warn',
        title: `Satellite ${event.key} config drift`,
        body: `${event.unacked} published config notification(s) went unacknowledged past the drift window.`,
        data: { satellite_key: event.key, unacked: event.unacked },
      });
    });

    // ── security alerts: failed sign-ins, throttled to one notice per hour ──

    this.events.on<{ reason: string; accountId?: string }>(EngineEvents.LoginFailure, (event) => {
      if (!event.accountId) {
        return; // unknown-account noise has no recipient to alert
      }
      void this.recordLoginFailure(event.accountId);
    });

    // ── account lifecycle (H-6/H-7 producers) ───────────────────────────────

    this.events.on<{ accountId: string; scheduledPurgeAt: string }>(EngineEvents.AccountDeletionRequested, (event) => {
      void this.notifyAccount(event.accountId, {
        kind: 'account.deletion_requested',
        severity: 'info',
        title: 'Your account deletion was scheduled',
        body: `The account will be permanently erased on ${event.scheduledPurgeAt.slice(0, 10)}. Sign back in before then to cancel.`,
        data: { scheduled_purge_at: event.scheduledPurgeAt },
        email: false, // the dedicated deletion receipt email already went out
      });
    });

    this.events.on<{ accountId: string; from: string; to: string }>(EngineEvents.AccountEmailChanged, (event) => {
      void this.notifyAccount(event.accountId, {
        kind: 'account.email_changed',
        severity: 'warn',
        title: 'Your email address was changed',
        body: `All sessions were signed out after the change to the new address.`,
        data: { from_domain: event.from.split('@')[1] ?? '' },
      });
    });
  }

  /** The core write: one in-app row (+ optional email), never throws to callers. */
  async notifyAccount(
    accountId: string,
    input: { orgId?: string | null; kind: string; severity: 'info' | 'warn' | 'error'; title: string; body?: string; data?: Record<string, unknown>; email?: boolean },
  ): Promise<void> {
    try {
      await this.db.root.insert(notifications).values({
        accountId,
        orgId: input.orgId ?? null,
        kind: input.kind,
        severity: input.severity,
        title: input.title.slice(0, 160),
        body: (input.body ?? '').slice(0, 1024),
        data: input.data ?? {},
      });
      if (input.email && input.severity !== 'info') {
        const account = await this.accounts.findById(accountId);
        if (account) {
          await this.email
            .sendTemplate({
              template: 'notification.generic',
              to: account.email,
              vars: { title: input.title.slice(0, 160), body: (input.body ?? '').slice(0, 500) },
              metadata: { accountId, kind: input.kind },
            })
            .catch(() => undefined);
        }
      }
    } catch (err) {
      NotificationsService.logger.error(`notification write failed (${input.kind}): ${(err as Error).message}`);
    }
  }

  /** Fan out to every member holding one of the roles (deduped). */
  async notifyOrgRoles(
    orgId: string,
    roles: string[],
    input: { kind: string; severity: 'info' | 'warn' | 'error'; title: string; body?: string; data?: Record<string, unknown>; email?: boolean },
  ): Promise<void> {
    try {
      const { members } = await this.memberships.listMembers(orgId);
      const targets = members.filter((m) => m.status === 'active' && roles.includes(m.role));
      for (const member of targets) {
        await this.notifyAccount(member.accountId, { ...input, orgId });
      }
    } catch (err) {
      NotificationsService.logger.error(`org-role notification failed (${input.kind} for ${orgId}): ${(err as Error).message}`);
    }
  }

  // ── subscriber helpers ─────────────────────────────────────────────────────

  /**
   * Fixed-window failure counter (Redis): the Nth failed sign-in inside one
   * hour trips exactly ONE notice — per-attempt security emails are their
   * own denial-of-service. Redis unavailable ⇒ skip silently.
   */
  private async recordLoginFailure(accountId: string): Promise<void> {
    const window = Math.floor(Date.now() / 3_600_000);
    const key = `notif:loginfail:${accountId}:${window}`;
    try {
      const count = await this.redis.raw.incr(key);
      if (count === 1) {
        await this.redis.raw.expire(key, 3700);
      }
      if (count !== NotificationsService.LOGIN_FAILURE_ALERT_THRESHOLD) {
        return;
      }
      await this.notifyAccount(accountId, {
        kind: 'security.login_failures',
        severity: 'warn',
        title: 'Multiple failed sign-in attempts',
        body: 'We blocked several failed attempts to sign in to your account in the last hour. If this was not you, change your password and enable two-factor authentication.',
        data: { window_hour: new Date(window * 3_600_000).toISOString() },
        email: true,
      });
    } catch (err) {
      NotificationsService.logger.warn(`login-failure alert accounting failed: ${(err as Error).message}`);
    }
  }

  /** Platform-plane events have no org/account target — the ops inbox only. */
  private async notifyPlatform(input: { kind: string; severity: 'info' | 'warn' | 'error'; title: string; body: string; data?: Record<string, unknown> }): Promise<void> {
    const inbox = env.CORPORATE_CONTACT_INBOX_EMAIL;
    if (!inbox) {
      return; // no team inbox configured on this deployment
    }
    await this.email
      .sendTemplate({
        template: 'notification.generic',
        to: inbox,
        vars: { title: input.title.slice(0, 160), body: input.body.slice(0, 500) },
        metadata: { kind: input.kind },
      })
      .catch(() => undefined);
  }

  // ── the account-facing feed ────────────────────────────────────────────────

  async list(accountId: string, unreadOnly = false, limit = 50): Promise<Array<typeof notifications.$inferSelect>> {
    return this.db.root
      .select()
      .from(notifications)
      .where(unreadOnly ? and(eq(notifications.accountId, accountId), isNull(notifications.readAt)) : eq(notifications.accountId, accountId))
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(limit, 200));
  }

  async markRead(accountId: string, notificationId: string): Promise<void> {
    await this.db.root
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.accountId, accountId)));
  }

  async markAllRead(accountId: string): Promise<void> {
    await this.db.root
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)));
  }

  async unreadCount(accountId: string): Promise<number> {
    const rows = await this.db.root
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.accountId, accountId), isNull(notifications.readAt)))
      .limit(500);
    return rows.length;
  }
}
