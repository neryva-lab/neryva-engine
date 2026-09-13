import { Injectable, Logger } from '@nestjs/common';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import { WebhooksService } from '../modules/webhooks/webhooks.service';

/**
 * Lifecycle webhook consumer (FL-2.26) — forwards durable conversation/run
 * lifecycle events to org-owned webhook endpoints through the EXISTING
 * signed dispatcher (HMAC + retry + delivery records live there). The
 * payload is the event's own bounded payload; failures ride the webhook
 * service's delivery machinery, not the outbox backoff.
 */
@Injectable()
export class LifecycleWebhookConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(LifecycleWebhookConsumer.name);

  readonly name = 'lifecycle-webhook';
  readonly eventTypes = [
    'run.completed',
    'run.failed',
    'run.canceled',
    'conversation.escalated',
    'conversation.escalation.claimed',
    'conversation.escalation.resolved',
  ];

  constructor(private readonly webhooks: WebhooksService) {}

  async handle(event: OutboxEvent): Promise<void> {
    try {
      await this.webhooks.dispatch(
        event.organizationId,
        event.eventType,
        {
          ...(event.payload ?? {}),
          event_id: event.eventId,
          occurred_at: event.createdAt,
        },
      );
    } catch (err) {
      // Webhook endpoint outages must not fail the outbox event: the webhook
      // service records the failed delivery for its own retry sweep.
      LifecycleWebhookConsumer.logger.warn(
        `lifecycle webhook dispatch skipped for ${event.eventType}: ${(err as Error).message}`,
      );
    }
  }
}
