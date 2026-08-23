import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { ConfigPublishService } from './config-publish.service';

/**
 * The config namespace worker (partitioning Tier-1: every module owns its
 * `{namespace}:default` queue). Job:
 *
 *  - `config.retention` (daily) — prune versions beyond the retention
 *    window per key (the live version is never eligible) and age out ACKed
 *    notification rows. Keeps the version store and the ledger bounded.
 *
 * Stale/unacked config notifications are NOT swept here: the satellites
 * sweeper (`satellites:default`, every minute) owns config-drift detection
 * and opens deduped `config_drift` incidents — one authority per fact.
 *
 * Failures retry with backoff; after the final attempt the job lands in the
 * failed set (BullMQ's DLQ) and is logged loudly — a missed sweep is
 * visible in ops, never silent.
 */
@Injectable()
export class ConfigPublishWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(ConfigPublishWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly publish: ConfigPublishService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('config');
    // Daily at 03:40 UTC — deliberately offset from the billing (03:15) and
    // org-purge (04:15) sweeps so maintenance load never stacks.
    await queue.add('config.retention', {}, { repeat: { pattern: '40 3 * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    this.worker = new Worker(
      'config:default',
      async (job: Job) => {
        if (job.name === 'config.retention') {
          const result = await this.publish.retentionSweep();
          if (result.versionsDeleted > 0 || result.notificationsDeleted > 0) {
            ConfigPublishWorker.logger.log(`retention: ${result.versionsDeleted} version(s), ${result.notificationsDeleted} acked notification(s) pruned`);
          }
          return result;
        }
        ConfigPublishWorker.logger.warn(`unknown config job "${job.name}" — discarding`);
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1, limiter: { max: 10, duration: 1000 } },
    );
    this.worker.on('failed', (job, err) => {
      ConfigPublishWorker.logger.error(`config job ${job?.name ?? '?'} failed (attempt ${job?.attemptsMade ?? 0}): ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
