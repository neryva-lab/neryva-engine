import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService, bullQueueName } from '../../common/infra/queue.service';
import { AccountDeletionService } from './account-deletion.service';

/**
 * The identity purge worker (`identity:` namespace — partitioning Tier-1):
 * a daily repeatable scan erases accounts whose deletion grace window
 * elapsed. Failures retry with backoff; a purge that keeps failing is loud
 * in logs and leaves the account row staged (deleted_at set) — the purge is
 * idempotent (deletes by id), so retries are always safe.
 */
@Injectable()
export class AccountPurgeWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(AccountPurgeWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly deletion: AccountDeletionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('identity');
    // Daily at 04:45 UTC — after the org purge scan.
    await queue.add('identity.purge_scan', {}, {
      repeat: { pattern: '45 4 * * *' },
      removeOnFail: { age: 30 * 86_400 },
      removeOnComplete: { age: 7 * 86_400 },
    });

    this.worker = new Worker(
      bullQueueName('identity'),
      async (job: Job) => {
        if (job.name === 'identity.purge_scan') {
          const purged = await this.deletion.purgeDue();
          if (purged.length > 0) {
            AccountPurgeWorker.logger.log(`purge scan: ${purged.length} account(s) erased`);
          }
          return { purged };
        }
        AccountPurgeWorker.logger.warn(`unknown identity job "${job.name}" — discarding`);
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      AccountPurgeWorker.logger.error(`identity job ${job?.name ?? '?'} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
