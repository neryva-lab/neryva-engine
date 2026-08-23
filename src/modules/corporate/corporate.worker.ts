import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { ContentService } from './content.service';
import { NewsletterService } from './newsletter.service';

/**
 * The corporate maintenance worker (`corporate:` namespace): the scheduled-
 * publish pass and the campaign sender. Cadence: every 5 minutes; when a
 * campaign is mid-flight the worker re-enqueues itself with a short delay
 * (2s) so sends proceed at CAMPAIGN_BATCH-per-tick throttle without waiting
 * out the 5-minute scan — resumable, bounded, self-terminating.
 */
const SCAN_CRON = '*/5 * * * *';
const DRAIN_DELAY_MS = 2_000;

@Injectable()
export class CorporateWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(CorporateWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly content: ContentService,
    private readonly newsletter: NewsletterService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('corporate');
    await queue.add(
      'corporate.maintenance',
      {},
      { repeat: { pattern: SCAN_CRON }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } },
    );

    this.worker = new Worker(
      'corporate:default',
      async (job: Job) => {
        if (job.name !== 'corporate.maintenance') {
          CorporateWorker.logger.warn(`unknown corporate job "${job.name}" — discarding`);
          return;
        }
        const published = await this.content.publishDue();
        const campaigns = await this.newsletter.processCampaigns();
        if (published > 0) {
          CorporateWorker.logger.log(`scheduled publish: ${published} post(s) went live`);
        }
        if (campaigns.remaining > 0) {
          // Mid-flight campaign: drain at batch cadence.
          await queue.add('corporate.maintenance', {}, { delay: DRAIN_DELAY_MS, attempts: 1, removeOnComplete: true, removeOnFail: true });
        }
        return { published, ...campaigns };
      },
      { connection: { url: env.REDIS_URL }, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      CorporateWorker.logger.error(`corporate job failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }
}
