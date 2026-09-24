import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { OutboxDispatcher } from '../common/infra/outbox/dispatcher';
import { DbService } from '../common/infra/db/db.service';
import { RunDispatchConsumer } from './run-dispatch.consumer';
import { TemplateProvisioningConsumer } from './template-provisioning.consumer';
import { RunCancelConsumer } from './run-cancel.consumer';
import { AnalyticsRollupConsumer } from './analytics-rollup.consumer';
import { MemoryProposerConsumer } from './memory-proposer.consumer';
import { LlmJudgeConsumer } from './llm-judge.consumer';
// Domain-owned consumers join via explicit @Inject tokens (never bare
// `import type` optionals — those emit a Function placeholder Nest cannot
// resolve, silently dropping the consumer). Each lives in its feature
// module, so flag-disabled deployments simply lack the provider and the
// @Optional() yields undefined.
import { UsageLedgerConsumer } from './usage-ledger.consumer';
import { LifecycleWebhookConsumer } from './lifecycle-webhook.consumer';
import { EvalExecutorConsumer } from './eval-executor.consumer';
import { EvalScoringConsumer } from './eval-scoring.consumer';
import { HumanLoopNotifyConsumer } from './human-loop-notify.consumer';
import { ChannelIngestConsumer } from '../modules/channels/ingest.service';
import { ChannelOutboundService } from '../modules/channels/outbound.service';
import { purgeExpiredIdempotencyRecords } from '../common/http/idempotency-records';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { env } from '../common/config/env';

/**
 * Worker host — Phase 6.3/6.6. Runs the outbox dispatcher on an interval
 * inside the monolith (single release artifact, ADR-001); the engine-api /
 * engine-worker / engine-dispatch role split happens at deploy time on the
 * same code (ledger 6.3). One tick runs at a time per process; a crashed
 * worker's CLAIMED rows are recovered by any surviving worker after the
 * stale-claim window (dispatcher.recoverStaleClaims).
 */
@Injectable()
export class OutboxDispatcherWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(OutboxDispatcherWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickCount = 0;

  private readonly dispatcher: OutboxDispatcher;

  constructor(
    private readonly db: DbService,
    runDispatch: RunDispatchConsumer,
    templateProvisioning: TemplateProvisioningConsumer,
    runCancel: RunCancelConsumer,
    analyticsRollup: AnalyticsRollupConsumer,
    memoryProposer: MemoryProposerConsumer,
    llmJudge: LlmJudgeConsumer,
    // Domain-owned consumers join only when their feature module is loaded
    // (billing/webhooks flags) — same pattern as the channel consumers below.
    @Optional() @Inject(UsageLedgerConsumer) usageLedger?: UsageLedgerConsumer,
    @Optional() @Inject(LifecycleWebhookConsumer) lifecycleWebhook?: LifecycleWebhookConsumer,
    // Eval-plane consumers (REL-2.1/2.2) join when conversations + knowledge
    // modules are loaded (GAP-03 — the consumer `eval.run_requested` never had).
    @Optional() @Inject(EvalExecutorConsumer) evalExecutor?: EvalExecutorConsumer,
    @Optional() @Inject(EvalScoringConsumer) evalScoring?: EvalScoringConsumer,
    @Optional() @Inject(HumanLoopNotifyConsumer) humanLoopNotify?: HumanLoopNotifyConsumer,
    // Channel-plane consumers join the dispatcher only when MODULES__CHANNELS_ENABLED.
    @Optional() @Inject(ChannelIngestConsumer) channelIngest?: ChannelIngestConsumer,
    @Optional() @Inject(ChannelOutboundService) channelOutbound?: ChannelOutboundService,
  ) {
    const consumers: OutboxConsumer[] = [runDispatch, templateProvisioning, runCancel, analyticsRollup, memoryProposer, llmJudge];
    if (usageLedger) {
      consumers.push(usageLedger);
    }
    if (lifecycleWebhook) {
      consumers.push(lifecycleWebhook);
    }
    if (evalExecutor) {
      consumers.push(evalExecutor);
    }
    if (evalScoring) {
      consumers.push(evalScoring);
    }
    if (channelIngest) {
      consumers.push(channelIngest);
    }
    if (channelOutbound) {
      consumers.push(channelOutbound);
    }
    if (humanLoopNotify) {
      consumers.push(humanLoopNotify);
    }
    this.dispatcher = new OutboxDispatcher(db, consumers, {
      batchSize: env.OUTBOX_BATCH_SIZE,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    });
  }

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED) {
      OutboxDispatcherWorker.logger.log('outbox dispatcher disabled (WORKERS__OUTBOX_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, env.OUTBOX_DISPATCH_INTERVAL_MS);
    this.timer.unref();
    OutboxDispatcherWorker.logger.log(`outbox dispatcher started (interval ${env.OUTBOX_DISPATCH_INTERVAL_MS}ms, batch ${env.OUTBOX_BATCH_SIZE})`);
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return; // one tick at a time per process — backpressure, not queueing
    }
    this.ticking = true;
    try {
      const result = await this.dispatcher.tick();
      if (result.claimed > 0) {
        OutboxDispatcherWorker.logger.log(
          `dispatch tick: claimed=${result.claimed} published=${result.published} retried=${result.retried} dead-lettered=${result.deadLettered} requeued=${result.requeued}`,
        );
      }
      // Bounded-growth sweep for the DB idempotency tier (~once a minute):
      // expired records stop serving replays and their keys become reclaimable.
      this.tickCount += 1;
      const sweepEvery = Math.max(1, Math.ceil(60_000 / Math.max(1, env.OUTBOX_DISPATCH_INTERVAL_MS)));
      if (this.tickCount % sweepEvery === 0) {
        const purged = await purgeExpiredIdempotencyRecords(this.db);
        if (purged > 0) {
          OutboxDispatcherWorker.logger.log(`idempotency sweep: purged ${purged} expired records`);
        }
      }
    } catch (err) {
      OutboxDispatcherWorker.logger.error(`dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Operator-authorized dead-letter replay (exposed to staff tooling later). */
  async replayDeadLetter(eventId: string): Promise<boolean> {
    return this.dispatcher.replayDeadLetter(eventId);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
