import { and, desc, eq } from 'drizzle-orm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { QueueService } from '../../common/infra/queue.service';
import { envelopeDecrypt, envelopeEncrypt, randomToken } from '../../common/infra/crypto/envelope';
import { webhooks, webhookDeliveries, WebhookRow } from './schema';
import { checkWebhookUrl } from './webhook-url.guard';

/**
 * The webhook dispatch service (gap P-1): org-owned endpoints receive
 * platform events. Coupling discipline: the service NEVER imports other
 * modules — it subscribes to the ENGINE EVENT BUS (the same decoupling the
 * notifications module uses), so entitlement/billing/deployment events fan
 * out with zero module edges.
 *
 * Event → webhook type mapping (the public event vocabulary, stable):
 *   entitlement.transitioned · billing.cost_anomaly
 *   deployment.completed/failed/rolled_back · org.ownership_transferred
 *   org.role_changed · org.deletion_requested · config.published
 */
export const PUBLIC_EVENTS = new Set([
  'entitlement.transitioned',
  'billing.cost_anomaly',
  'deployment.completed',
  'deployment.failed',
  'deployment.rolled_back',
  'org.ownership_transferred',
  'org.role_changed',
  'org.deletion_requested',
  'config.published',
]);

/** The subscribable event vocabulary — exposed via GET events for the console. */
export function webhookEventCatalog(): Array<{ type: string }> {
  return [...PUBLIC_EVENTS].sort().map((type) => ({ type }));
}

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const MAX_ATTEMPTS = 5;

@Injectable()
export class WebhooksService implements OnModuleInit {
  private static readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    // The engine-event → webhook bridge. Payloads must carry orgId.
    for (const [engineEvent, publicType] of [
      [EngineEvents.EntitlementTransitioned, 'entitlement.transitioned'],
      [EngineEvents.DeploymentCompleted, 'deployment.completed'],
      [EngineEvents.DeploymentFailed, 'deployment.failed'],
      [EngineEvents.DeploymentRolledBack, 'deployment.rolled_back'],
      [EngineEvents.OrgOwnershipTransferred, 'org.ownership_transferred'],
      [EngineEvents.OrgRoleChanged, 'org.role_changed'],
      [EngineEvents.OrgDeletionRequested, 'org.deletion_requested'],
      [EngineEvents.ConfigPublished, 'config.published'],
      ['billing.cost_anomaly', 'billing.cost_anomaly'],
    ] as Array<[string, string]>) {
      this.events.on<Record<string, unknown>>(engineEvent, (payload) => {
        const orgId = typeof payload?.orgId === 'string' ? payload.orgId : null;
        if (orgId) {
          void this.dispatch(orgId, publicType, payload).catch(() => undefined);
        }
      });
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async create(input: { orgId: string; url: string; events: string[]; description?: string; actorId: string }): Promise<{ webhook: WebhookRow; secret: string }> {
    const urlCheck = await checkWebhookUrl(input.url);
    if (!urlCheck.ok) {
      throw ApiError.validation({ url: urlCheck.reason ?? 'unacceptable target' });
    }
    const events = this.validateEvents(input.events);
    const secret = `whsec_${randomToken(24)}`;
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(webhooks)
        .values({
          orgId: input.orgId,
          url: input.url,
          events,
          secretEnvelope: envelopeEncrypt(secret),
          description: input.description?.slice(0, 256),
          createdBy: null,
        })
        .returning(),
    );
    await this.audit.add({
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { events: events.join(','), url_host: new URL(input.url).host },
    });
    return { webhook: this.redact(inserted[0]), secret }; // shown exactly once
  }

  async list(orgId: string): Promise<WebhookRow[]> {
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(webhooks).where(eq(webhooks.orgId, orgId)).orderBy(desc(webhooks.createdAt)));
    return rows.map((row) => this.redact(row));
  }

  async update(input: { orgId: string; webhookId: string; url?: string; events?: string[]; description?: string; status?: 'active' | 'disabled'; actorId: string }): Promise<WebhookRow> {
    const existing = await this.require(input.orgId, input.webhookId);
    const patch: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (input.url && input.url !== existing.url) {
      const urlCheck = await checkWebhookUrl(input.url);
      if (!urlCheck.ok) {
        throw ApiError.validation({ url: urlCheck.reason ?? 'unacceptable target' });
      }
      patch.url = input.url;
    }
    if (input.events) {
      patch.events = this.validateEvents(input.events);
    }
    if (input.description !== undefined) {
      patch.description = input.description?.slice(0, 256);
    }
    if (input.status) {
      patch.status = input.status;
    }
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx.update(webhooks).set(patch).where(and(eq(webhooks.id, input.webhookId), eq(webhooks.orgId, input.orgId))).returning(),
    );
    await this.audit.add({
      action: 'webhook.updated',
      resourceType: 'webhook',
      resourceId: input.webhookId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { status: input.status ?? existing.status },
    });
    return this.redact(updated[0]);
  }

  async remove(input: { orgId: string; webhookId: string; actorId: string }): Promise<void> {
    await this.require(input.orgId, input.webhookId);
    await this.db.withOrg(input.orgId, (tx) => tx.delete(webhooks).where(and(eq(webhooks.id, input.webhookId), eq(webhooks.orgId, input.orgId))));
    await this.audit.add({
      action: 'webhook.deleted',
      resourceType: 'webhook',
      resourceId: input.webhookId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  async deliveries(orgId: string, webhookId: string, limit = 50): Promise<Array<typeof webhookDeliveries.$inferSelect>> {
    await this.require(orgId, webhookId);
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.webhookId, webhookId)))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(Math.min(limit, 200)),
    );
  }

  /** Rotate the signing secret (old one dies immediately). Returned once. */
  async rotateSecret(input: { orgId: string; webhookId: string; actorId: string }): Promise<{ secret: string }> {
    const existing = await this.require(input.orgId, input.webhookId);
    const secret = `whsec_${randomToken(24)}`;
    await this.db.withOrg(input.orgId, (tx) =>
      tx.update(webhooks).set({ secretEnvelope: envelopeEncrypt(secret), updatedAt: new Date().toISOString() }).where(eq(webhooks.id, existing.id)),
    );
    await this.audit.add({
      action: 'webhook.secret_rotated',
      resourceType: 'webhook',
      resourceId: existing.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
    return { secret };
  }

  /** Send a test event (validates the endpoint end-to-end). */
  async sendTest(input: { orgId: string; webhookId: string; actorId: string }): Promise<{ deliveryId: string }> {
    await this.require(input.orgId, input.webhookId);
    return this.dispatch(input.orgId, 'webhook.test', { org_id: input.orgId, test: true, at: new Date().toISOString() }, input.webhookId);
  }

  // ── dispatch + delivery ────────────────────────────────────────────────────

  /** Fan an event out to the org's subscribed, active webhooks. */
  async dispatch(orgId: string, eventType: string, payload: Record<string, unknown>, onlyWebhookId?: string): Promise<{ deliveryId: string }> {
    let lastId = '';
    const targets = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(webhooks).where(and(eq(webhooks.orgId, orgId), eq(webhooks.status, 'active'))),
    );
    for (const target of targets) {
      if (onlyWebhookId && target.id !== onlyWebhookId) {
        continue;
      }
      const subscribed = (target.events as string[]).includes('*') || (target.events as string[]).includes(eventType);
      if (!subscribed) {
        continue;
      }
      const inserted = await this.db.withOrg(orgId, (tx) =>
        tx.insert(webhookDeliveries).values({
          orgId,
          webhookId: target.id,
          eventType,
          payload: { type: eventType, created_at: new Date().toISOString(), data: payload },
          status: 'pending',
        }).returning({ id: webhookDeliveries.id }),
      );
      lastId = inserted[0].id;
      await this.queues.queue('webhooks').add('webhook.deliver', { deliveryId: inserted[0].id }, {
        attempts: 1, // retries are managed by the service (backoff table), not BullMQ
        removeOnComplete: { age: 7 * 86_400 },
        removeOnFail: { age: 30 * 86_400 },
      });
    }
    return { deliveryId: lastId };
  }

  /** One delivery attempt; reschedules itself via the backoff table. */
  async attemptDelivery(deliveryId: string): Promise<'delivered' | 'retry_scheduled' | 'dead' | 'gone'> {
    const rows = await this.db.withBypass((tx) =>
      // Justification (withBypass): the worker drains the cross-org queue —
      // the delivery row is addressed by its unique id.
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1),
    );
    const delivery = rows[0];
    if (!delivery || delivery.status === 'delivered' || delivery.status === 'dead') {
      return 'gone';
    }
    const hookRows = await this.db.withBypass((tx) => tx.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).limit(1));
    const hook = hookRows[0];
    if (!hook || hook.status !== 'active') {
      await this.finishDelivery(delivery.orgId, delivery.id, { status: 'dead', lastError: 'webhook disabled or removed' });
      return 'dead';
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', envelopeDecrypt(hook.secretEnvelope)).update(`${timestamp}.${body}`).digest('hex');

    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'neryva-webhooks/1.0',
          'x-neryva-event': delivery.eventType,
          'x-neryva-timestamp': String(timestamp),
          'x-neryva-signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error', // never follow redirects (SSRF re-check bypass)
      });
      if (response.ok) {
        await this.finishDelivery(delivery.orgId, delivery.id, { status: 'delivered', responseStatus: response.status });
        return 'delivered';
      }
      return await this.scheduleRetry(delivery.orgId, delivery.id, delivery.attempts, `HTTP ${response.status}`);
    } catch (err) {
      return await this.scheduleRetry(delivery.orgId, delivery.id, delivery.attempts, (err as Error).message.slice(0, 480));
    }
  }

  private async scheduleRetry(orgId: string, deliveryId: string, attemptsSoFar: number, error: string): Promise<'retry_scheduled' | 'dead'> {
    const attempts = attemptsSoFar + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.finishDelivery(orgId, deliveryId, { status: 'dead', lastError: error, attempts });
      await this.events.emit(EngineEvents.WebhookDead, { orgId, deliveryId }).catch(() => undefined);
      return 'dead';
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'failed', attempts, lastError: error, nextAttemptAt, updatedAt: new Date().toISOString() })
        .where(eq(webhookDeliveries.id, deliveryId)),
    );
    await this.queues.queue('webhooks').add('webhook.deliver', { deliveryId }, { delay, attempts: 1, removeOnComplete: { age: 7 * 86_400 }, removeOnFail: { age: 30 * 86_400 } });
    return 'retry_scheduled';
  }

  private async finishDelivery(orgId: string, deliveryId: string, patch: { status: string; lastError?: string; responseStatus?: number; attempts?: number }): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          status: patch.status,
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.responseStatus !== undefined ? { responseStatus: patch.responseStatus } : {}),
          ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
          ...(patch.status === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(webhookDeliveries.id, deliveryId)),
    );
  }

  private async require(orgId: string, webhookId: string): Promise<WebhookRow> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId))).limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('webhook');
    }
    return rows[0];
  }

  private validateEvents(events: string[]): string[] {
    if (!Array.isArray(events) || events.length === 0 || events.length > 20) {
      throw ApiError.validation({ events: '1..20 event types (or ["*"])' });
    }
    const normalized = events.map((e) => String(e));
    if (normalized.includes('*')) {
      return ['*'];
    }
    const unknown = normalized.filter((e) => !PUBLIC_EVENTS.has(e));
    if (unknown.length > 0) {
      throw ApiError.validation({ events: `unknown event type(s): ${unknown.join(', ')} — allowed: ${[...PUBLIC_EVENTS].join(', ')}, *` });
    }
    return normalized;
  }

  private redact(row: WebhookRow): WebhookRow {
    return { ...row, secretEnvelope: '' };
  }
}
