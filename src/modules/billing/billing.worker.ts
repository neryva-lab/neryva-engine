import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { AnomalyService } from './anomaly.service';

/**
 * The billing namespace worker (partitioning Tier-1: every module owns its
 * `{namespace}:default` queue). Jobs:
 *
 *  - `billing.anomaly_scan` (repeatable, daily) — the B-5 cost-anomaly pass.
 *
 * Failures retry with backoff; after the final attempt the job lands in the
 * failed set (BullMQ's DLQ) and is logged loudly — a missed daily scan is
 * visible in ops, never silent.
 */
@Injectable()
export class BillingWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(BillingWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly anomalies: AnomalyService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('billing');
    // Daily at 03:15 UTC — after the day closes everywhere on earth's date line.
    await queue.add('billing.anomaly_scan', {}, { repeat: { pattern: env.BILLING_ANOMALY_CRON }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    this.worker = new Worker(
      'billing:default',
      async (job: Job) => {
        if (job.name === 'billing.anomaly_scan') {
          const result = await this.anomalies.scan();
          BillingWorker.logger.log(`anomaly scan complete: ${result.checked} ledger(s) checked, ${result.anomalies.length} flagged`);
          return result;
        }
        BillingWorker.logger.warn(`unknown billing job "${job.name}" — discarding`);
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1, limiter: { max: 10, duration: 1000 } },
    );
    this.worker.on('failed', (job, err) => {
      BillingWorker.logger.error(`billing job ${job?.name ?? '?'} failed (attempt ${job?.attemptsMade ?? 0}): ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
