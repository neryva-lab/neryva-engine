import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { webhooksDelivered } from '../../common/observability/metrics';
import { WebhooksService } from './webhooks.service';

/**
 * The webhook delivery worker (`webhooks:` namespace): drains delivery
 * jobs, one attempt per job — retries are rescheduled by the service with
 * its backoff table, so worker crashes never lose a retry slot. Outcome
 * metrics feed the observability plane (delivered / retry / dead).
 */
@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(WebhookWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly webhooks: WebhooksService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.worker = new Worker(
      'webhooks:default',
      async (job: Job<{ deliveryId: string }>) => {
        if (job.name !== 'webhook.deliver' || !job.data?.deliveryId) {
          WebhookWorker.logger.warn(`unknown webhooks job "${job.name}" — discarding`);
          return;
        }
        const outcome = await this.webhooks.attemptDelivery(job.data.deliveryId);
        webhooksDelivered.inc({ outcome });
        return outcome;
      },
      { connection: { url: env.REDIS_URL }, concurrency: 8, limiter: { max: 50, duration: 1000 } },
    );
    this.worker.on('failed', (job, err) => {
      // A worker-level failure (not a delivery failure — those are handled
      // inside attemptDelivery) — log loudly; the job's removeOnFail keeps
      // the queue bounded and the delivery row says 'pending/failed'.
      WebhookWorker.logger.error(`webhook job ${job?.id ?? '?'} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
