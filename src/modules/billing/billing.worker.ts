import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService, bullQueueName } from '../../common/infra/queue.service';
import { AnomalyService } from './anomaly.service';
import { BillingCreditsService } from './billing-credits.service';
import { BillingCycleService } from './billing-cycle.service';
import { QuotaService } from './quota.service';
import { UsageLedgerService } from './usage-ledger.service';
import { TrialExpiryService } from './trial-expiry.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BurnRateService } from '../assistants/burn-rate.service';
import { DbService } from '../../common/infra/db/db.service';
import { sql } from 'drizzle-orm';

/**
 * The billing namespace worker (partitioning Tier-1: every module owns its
 * `{namespace}:default` queue). Jobs:
 *
 *  - `billing.anomaly_scan` (repeatable, daily) — the B-5 cost-anomaly pass.
 *  - `billing.trial_sweep` (repeatable, hourly) — H-3 trial expiry.
 *  - `billing.quota_reconcile` (repeatable, hourly) — M-1 counter resync.
 *  - `billing.burn_sweep` (repeatable, hourly) — REL-11.3 burn-rate auto-pause
 *    over spend-gated candidates (assistants with an active production
 *    rollout in orgs that spent in the last hour).
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
    private readonly trialExpiry: TrialExpiryService,
    private readonly quota: QuotaService,
    private readonly ledger: UsageLedgerService,
    private readonly burnRate: BurnRateService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('billing');
    // Daily at 03:15 UTC — after the day closes everywhere on earth's date line.
    await queue.add('billing.anomaly_scan', {}, { repeat: { pattern: env.BILLING_ANOMALY_CRON }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    // B-2: month-end auto-invoicing — draft every ledger with spend on the 1st, 00:10 UTC.
    await queue.add('billing.cycle_draft', {}, { repeat: { pattern: '10 0 1 * *' }, removeOnFail: { age: 90 * 86_400 }, removeOnComplete: { age: 90 * 86_400 } });
    // B-3: budget threshold evaluation — hourly, so 50/80/100% alerts land the hour they cross.
    await queue.add('billing.budget_eval', {}, { repeat: { pattern: '5 * * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    // H-3: expired-trial sweep — hourly at :40 (offset from the other passes).
    await queue.add('billing.trial_sweep', {}, { repeat: { pattern: env.BILLING_TRIAL_SWEEP_CRON }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });
    // M-1: quota-counter reconciliation — hourly at :20, after most ingest traffic.
    await queue.add('billing.quota_reconcile', {}, { repeat: { pattern: env.BILLING_QUOTA_RECONCILE_CRON }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });
    // REL-11.3: burn-rate auto-pause sweep — hourly at :50, after trial/quota passes.
    await queue.add('billing.burn_sweep', {}, { repeat: { pattern: '50 * * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    this.worker = new Worker(
      bullQueueName('billing'),
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
        if (job.name === 'billing.trial_sweep') {
          const result = await this.trialExpiry.sweep();
          if (result.expired > 0) {
            BillingWorker.logger.log(`trial sweep: ${result.expired} of ${result.scanned} expired trial(s) transitioned`);
          }
          return result;
        }
        if (job.name === 'billing.quota_reconcile') {
          // W2.3 — reclaim lapsed RESERVED rows (runs that died without a
          // terminal transition) before resyncing the counters, so neither
          // plane accumulates orphaned holds.
          const expired = await this.ledger.expireLapsed();
          const result = await this.quota.reconcileMonth();
          BillingWorker.logger.log(
            `quota reconcile: ${result.counters} counters resynced across ${result.ledgers} ledger(s), ${expired} lapsed reservation(s) reclaimed`,
          );
          return result;
        }
        if (job.name === 'billing.burn_sweep') {
          const candidates = await this.burnRate.sweepCandidates();
          let paused = 0;
          let suppressed = 0;
          for (const c of candidates) {
            const check = await this.burnRate.checkAndMaybeRollback({ orgId: c.orgId, assistantId: c.assistantId });
            if (check.action === 'paused_rollout') {
              paused += 1;
            } else if (check.action === 'suppressed') {
              suppressed += 1;
            }
          }
          if (paused > 0 || suppressed > 0) {
            BillingWorker.logger.warn(`burn sweep: ${paused} paused, ${suppressed} suppressed (manual-resume cooldown) across ${candidates.length} candidate(s)`);
          }
          return { checked: candidates.length, paused, suppressed };
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
