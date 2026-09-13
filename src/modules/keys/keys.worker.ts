import { OnModuleDestroy, OnModuleInit, Injectable, Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService, bullQueueName } from '../../common/infra/queue.service';
import { KeysService } from './keys.service';

/**
 * The keys namespace worker (partitioning Tier-1): the daily expiring-key
 * scan (K-4) — keys inside the 14-day horizon notify their org's
 * owner/admin exactly once per day per key until rotated or expired.
 */
@Injectable()
export class KeysWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(KeysWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly keys: KeysService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('keys');
    // Daily at 06:00 UTC — before EU business hours, after the US day closes.
    await queue.add('keys.expiring_scan', {}, { repeat: { pattern: '0 6 * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    this.worker = new Worker(
      bullQueueName('keys'),
      async (job: Job) => {
        if (job.name === 'keys.expiring_scan') {
          const sent = await this.keys.notifyExpiringKeys(14);
          if (sent > 0) {
            KeysWorker.logger.log(`expiring-key scan: ${sent} notification(s) sent`);
          }
          return { sent };
        }
        KeysWorker.logger.warn(`unknown keys job "${job.name}" — discarding`);
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      KeysWorker.logger.error(`keys job ${job?.name ?? '?'} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
