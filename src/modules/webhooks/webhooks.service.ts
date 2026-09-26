import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { QueueService } from '../../common/infra/queue.service';
import { envelopeDecrypt, envelopeEncrypt, randomToken } from '../../common/infra/crypto/envelope';
import type { WebhookDeliveryRow, WebhookRow } from './schema';
import { checkWebhookUrl, recheckWebhookTarget } from './webhook-url.guard';
import { WEBHOOK_DELIVERY_REPOSITORY, WEBHOOK_REPOSITORY } from './repositories/repository-tokens';
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  type IWebhookDeliveryRepository,
  type IWebhookRepository,
  type WebhookUpdatePatch,
} from './repositories/webhooks.repository';

export { MAX_ATTEMPTS, RETRY_DELAYS_MS };

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

@Injectable()
export class WebhooksService implements OnModuleInit {
  private static readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(WEBHOOK_REPOSITORY) private readonly webhooks: IWebhookRepository,
    @Inject(WEBHOOK_DELIVERY_REPOSITORY) private readonly deliveryRepo: IWebhookDeliveryRepository,
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
    const inserted = await this.webhooks.createWebhook({
      orgId: input.orgId,
      url: input.url,
      events,
      secretEnvelope: envelopeEncrypt(secret),
      description: input.description?.slice(0, 256),
    });
    await this.audit.add({
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { events: events.join(','), url_host: new URL(input.url).host },
    });
    return { webhook: this.redact(inserted), secret }; // shown exactly once
  }

  async list(orgId: string): Promise<Array<WebhookRow & { secretHint: string | null }>> {
    const rows = await this.webhooks.listWebhooks(orgId);
    return rows.map((row) => ({ ...this.redact(row), secretHint: this.secretHint(row.secretEnvelope) }));
  }

  /** Last-4 hint of the signing secret for the console's secret-hint slot (P5-W6). Never the secret itself. */
  private secretHint(secretEnvelope: string): string | null {
    try {
      const secret = envelopeDecrypt(secretEnvelope);
      return secret.length >= 4 ? `…${secret.slice(-4)}` : null;
    } catch {
      return null;
    }
  }

  async update(input: { orgId: string; webhookId: string; url?: string; events?: string[]; description?: string; status?: 'active' | 'disabled'; actorId: string }): Promise<WebhookRow> {
    const existing = await this.require(input.orgId, input.webhookId);
    const patch: WebhookUpdatePatch = { updatedAt: new Date().toISOString() };
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
    const updated = await this.webhooks.updateWebhook(input.orgId, input.webhookId, patch);
    await this.audit.add({
      action: 'webhook.updated',
      resourceType: 'webhook',
      resourceId: input.webhookId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { status: input.status ?? existing.status },
    });
    // Mechanical: mirrors the original `redact(updated[0])` — require and
    // the update are separate units, so a row deleted between them redacts
    // to `{}` here at runtime. Known pre-existing race, recorded, not fixed.
    return this.redact(updated);
  }

  async remove(input: { orgId: string; webhookId: string; actorId: string }): Promise<void> {
    await this.require(input.orgId, input.webhookId);
    await this.webhooks.deleteWebhook(input.orgId, input.webhookId);
    await this.audit.add({
      action: 'webhook.deleted',
      resourceType: 'webhook',
      resourceId: input.webhookId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  async deliveries(orgId: string, webhookId: string, limit = 50, offset = 0): Promise<WebhookDeliveryRow[]> {
    await this.require(orgId, webhookId);
    return this.deliveryRepo.listDeliveries(
      orgId,
      webhookId,
      Math.min(Math.max(limit, 1), 200),
      Math.max(offset, 0),
    );
  }

  /**
   * Stranded-delivery sweep (P5-W13): re-enqueue delivery rows the live path
   * lost — `pending` rows older than 5 minutes that were never picked up
   * (insert succeeded, enqueue failed/died), and `failed` rows whose
   * `nextAttemptAt` is past but which still have attempts left (the retry
   * enqueue never landed). The repository claims atomically so concurrent
   * sweeps/workers never double-claim; the deterministic jobId makes even a
   * raced re-enqueue a no-op instead of a double delivery.
   */
  async sweepStrandedDeliveries(batchSize: number): Promise<number> {
    const claimed = await this.deliveryRepo.claimStrandedDeliveries(batchSize);
    let requeued = 0;
    for (const row of claimed) {
      try {
        await this.enqueueDelivery(row.id, row.attempts);
        requeued += 1;
      } catch (err) {
        WebhooksService.logger.warn(`delivery sweep re-enqueue failed for ${row.id}: ${(err as Error).message}`);
      }
    }
    if (requeued > 0) {
      WebhooksService.logger.log(`webhook delivery sweep re-queued ${requeued} stranded delivery(ies)`);
    }
    return requeued;
  }

  /** Rotate the signing secret (old one dies immediately). Returned once. */
  async rotateSecret(input: { orgId: string; webhookId: string; actorId: string }): Promise<{ secret: string }> {
    const existing = await this.require(input.orgId, input.webhookId);
    const secret = `whsec_${randomToken(24)}`;
    await this.webhooks.rotateSecret(input.orgId, existing.id, envelopeEncrypt(secret));
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

  /** Send a test event (validates the endpoint end-to-end). A targeted test
   *  always reaches its webhook — the subscription check is bypassed, because
   *  the point of "test" is to verify the destination, not the filter. */
  async sendTest(input: { orgId: string; webhookId: string; actorId: string }): Promise<{ deliveryId: string }> {
    await this.require(input.orgId, input.webhookId);
    return this.dispatch(input.orgId, 'webhook.test', { org_id: input.orgId, test: true, at: new Date().toISOString() }, input.webhookId, true);
  }

  // ── dispatch + delivery ────────────────────────────────────────────────────

  /**
   * Fan an event out to the org's subscribed, active webhooks.
   *
   * The delivery-row insert and the BullMQ enqueue are two separate durable
   * steps (no distributed transaction): if the enqueue throws, the row is
   * parked as `failed` with an imminent `nextAttemptAt` so the stranded-
   * delivery sweep picks it up instead of leaving it `pending` forever.
   * Enqueues carry a deterministic jobId (`webhook-deliver:<id>:<attempts>`)
   * so a sweep re-enqueue can never double-deliver against the live path.
   */
  async dispatch(orgId: string, eventType: string, payload: Record<string, unknown>, onlyWebhookId?: string, ignoreSubscription = false): Promise<{ deliveryId: string }> {
    let lastId = '';
    const targets = await this.webhooks.listActiveWebhooks(orgId);
    for (const target of targets) {
      if (onlyWebhookId && target.id !== onlyWebhookId) {
        continue;
      }
      const subscribed = ignoreSubscription || (target.events as string[]).includes('*') || (target.events as string[]).includes(eventType);
      if (!subscribed) {
        continue;
      }
      const deliveryId = await this.deliveryRepo.createDelivery({ orgId, webhookId: target.id, eventType, data: payload });
      lastId = deliveryId;
      try {
        await this.enqueueDelivery(deliveryId, 0);
      } catch (err) {
        // The row exists but no job was queued — park it for the sweep
        // instead of stranding it as `pending` forever (P5-W13).
        WebhooksService.logger.warn(`webhook enqueue failed for delivery ${deliveryId}: ${(err as Error).message}`);
        await this.deliveryRepo.parkEnqueueFailure(
          orgId,
          deliveryId,
          `enqueue failed: ${(err as Error).message}`.slice(0, 512),
          new Date(Date.now() + 60_000).toISOString(),
        );
      }
    }
    return { deliveryId: lastId };
  }

  /** Enqueue one delivery attempt with a deterministic jobId for dedup. */
  private async enqueueDelivery(deliveryId: string, attempts: number, delayMs = 0): Promise<void> {
    await this.queues.queue('webhooks').add('webhook.deliver', { deliveryId }, {
      attempts: 1, // retries are managed by the service (backoff table), not BullMQ
      delay: delayMs,
      jobId: `webhook-deliver:${deliveryId}:${attempts}`,
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: { age: 30 * 86_400 },
    });
  }

  /** One delivery attempt; reschedules itself via the backoff table. */
  async attemptDelivery(deliveryId: string): Promise<'delivered' | 'retry_scheduled' | 'dead' | 'gone'> {
    const delivery = await this.deliveryRepo.getDeliveryUnchecked(deliveryId);
    if (!delivery || delivery.status === 'delivered' || delivery.status === 'dead') {
      return 'gone';
    }
    const hook = await this.webhooks.getWebhookUnchecked(delivery.webhookId);
    if (!hook || hook.status !== 'active') {
      await this.deliveryRepo.markDeliveryDead(delivery.orgId, delivery.id, 'webhook disabled or removed');
      return 'dead';
    }

    // Delivery-time SSRF re-check (P5-W7): the host is re-resolved fresh on
    // every attempt, so DNS drift/rebinding after the create-time check
    // cannot smuggle a blocked target past the guard.
    const recheck = await recheckWebhookTarget(hook.url);
    if (!recheck.ok) {
      await this.deliveryRepo.markDeliveryDead(delivery.orgId, delivery.id, `delivery-time target check failed: ${recheck.reason ?? 'blocked'}`);
      return 'dead';
    }

    let secret: string;
    try {
      secret = envelopeDecrypt(hook.secretEnvelope);
    } catch (err) {
      // The secret can never be recovered — retrying is pointless.
      await this.deliveryRepo.markDeliveryDead(delivery.orgId, delivery.id, `signing secret unreadable: ${(err as Error).message}`.slice(0, 512));
      return 'dead';
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

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
        await this.deliveryRepo.markDeliveryDelivered(delivery.orgId, delivery.id, response.status);
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
      await this.deliveryRepo.markDeliveryDead(orgId, deliveryId, error, attempts);
      await this.events.emit(EngineEvents.WebhookDead, { orgId, deliveryId }).catch(() => undefined);
      return 'dead';
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    await this.deliveryRepo.markDeliveryRetryable(orgId, deliveryId, attempts, error, nextAttemptAt);
    await this.enqueueDelivery(deliveryId, attempts, delay);
    return 'retry_scheduled';
  }

  private async require(orgId: string, webhookId: string): Promise<WebhookRow> {
    const row = await this.webhooks.getWebhook(orgId, webhookId);
    if (!row) {
      throw ApiError.notFound('webhook');
    }
    return row;
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
