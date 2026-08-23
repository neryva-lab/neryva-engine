import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { OrgLifecycleService } from './org-lifecycle.service';

/**
 * The org-purge worker (`organizations:` namespace — partitioning Tier-1):
 * a daily repeatable scan purges orgs whose deletion grace window elapsed.
 * Failures retry with backoff; a purge that keeps failing is loud in logs
 * and leaves the org row in `requested` — the purge is idempotent (deletes
 * by org_id), so retries are always safe.
 */
@Injectable()
export class OrgPurgeWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(OrgPurgeWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly lifecycle: OrgLifecycleService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('organizations');
    // Daily at 04:15 UTC — after the billing anomaly scan, before business hours.
    await queue.add('organizations.purge_scan', {}, {
      repeat: { pattern: '15 4 * * *' },
      removeOnFail: { age: 30 * 86_400 },
      removeOnComplete: { age: 7 * 86_400 },
    });

    this.worker = new Worker(
      'organizations:default',
      async (job: Job) => {
        if (job.name === 'organizations.purge_scan') {
          const purged = await this.lifecycle.purgeDue();
          if (purged.length > 0) {
            OrgPurgeWorker.logger.log(`purge scan: ${purged.length} org(s) erased`);
          }
          return { purged };
        }
        OrgPurgeWorker.logger.warn(`unknown organizations job "${job.name}" — discarding`);
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      OrgPurgeWorker.logger.error(`organizations job ${job?.name ?? '?'} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
