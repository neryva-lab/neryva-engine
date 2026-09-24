import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { env } from '../common/config/env';
import { WebhooksService } from '../modules/webhooks/webhooks.service';

/**
 * Webhook-delivery sweep (P5-W13).
 *
 * The dispatch path's insert + BullMQ enqueue are two separate durable
 * steps — if the enqueue throws or the host dies between them, the delivery
 * row sits `pending` (or `failed` with a past `nextAttemptAt`) and no job
 * will ever claim it. This worker re-queues those stranded rows so every
 * durable side effect keeps a reconciliation path (architecture invariant 6).
 *
 * Claims are `FOR UPDATE SKIP LOCKED` (concurrent sweepers/workers never
 * double-claim) and every re-enqueue carries the same deterministic jobId
 * the live path uses (`webhook-deliver:<id>:<attempts>`), so even a raced
 * enqueue dedups inside BullMQ instead of double-delivering.
 *
 * A tick never throws — a dead sweep must not take the worker host down
 * with it. Like every other worker on this host, the sweep stays off when
 * the outbox deployment is disabled.
 */
@Injectable()
export class WebhookDeliverySweepWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(WebhookDeliverySweepWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly webhooks: WebhooksService) {}

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED || !env.WORKERS__WEBHOOK_SWEEP_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), env.WORKERS__WEBHOOK_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.webhooks.sweepStrandedDeliveries(env.WORKERS__WEBHOOK_SWEEP_BATCH);
    } catch (err: unknown) {
      WebhookDeliverySweepWorker.logger.warn(`webhook delivery sweep failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
