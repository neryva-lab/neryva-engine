import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { AnomalyService } from './anomaly.service';
import { BillingCreditsService } from './billing-credits.service';
import { BillingCycleService } from './billing-cycle.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DbService } from '../../common/infra/db/db.service';
import { sql } from 'drizzle-orm';

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
    private readonly credits: BillingCreditsService,
    private readonly cycle: BillingCycleService,
    private readonly notifications: NotificationsService,
    private readonly db: DbService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('billing');
    // Daily at 03:15 UTC — after the day closes everywhere on earth's date line.
    await queue.add('billing.anomaly_scan', {}, { repeat: { pattern: env.BILLING_ANOMALY_CRON }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    // B-2: month-end auto-invoicing — draft every ledger with spend on the 1st, 00:10 UTC.
    await queue.add('billing.cycle_draft', {}, { repeat: { pattern: '10 0 1 * *' }, removeOnFail: { age: 90 * 86_400 }, removeOnComplete: { age: 90 * 86_400 } });
    // B-3: budget threshold evaluation — hourly, so 50/80/100% alerts land the hour they cross.
    await queue.add('billing.budget_eval', {}, { repeat: { pattern: '5 * * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    this.worker = new Worker(
      'billing:default',
      async (job: Job) => {
        if (job.name === 'billing.cycle_draft') {
          const result = await this.cycle.runForPreviousMonth();
          BillingWorker.logger.log(`cycle draft complete: ${result.drafted} drafted, ${result.skipped} skipped, $${result.total_usd}`);
          return result;
        }
        if (job.name === 'billing.budget_eval') {
          const result = await this.credits.evaluateBudgets(async (orgId, product, _projectId) => {
            const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z').toISOString();
            const rows = await this.db.withBypass((tx) =>
              tx.execute<{ total: string }>(sql`
                select coalesce(sum(cost_usd), 0)::text as total from billing.spend_events
                where org_id = ${orgId} and occurred_at >= ${monthStart}::timestamptz
                  ${product ? sql`and product = ${product}` : sql``}
              `),
            );
            return Number(rows.rows[0]?.total ?? 0);
          }, this.notifications);
          if (result.alerted > 0) {
            BillingWorker.logger.log(`budget evaluation: ${result.alerted} threshold alert(s) sent`);
          }
          return result;
        }
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
