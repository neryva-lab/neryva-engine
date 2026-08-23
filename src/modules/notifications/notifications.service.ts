import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
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
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private static readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly db: DbService,
    private readonly events: EventBus,
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
