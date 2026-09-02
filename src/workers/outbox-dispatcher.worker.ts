import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OutboxDispatcher } from '../common/infra/outbox/dispatcher';
import { DbService } from '../common/infra/db/db.service';
import { RunDispatchConsumer } from './run-dispatch.consumer';
import { UsageLedgerConsumer } from './usage-ledger.consumer';
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

  private readonly dispatcher: OutboxDispatcher;

  constructor(
    db: DbService,
    runDispatch: RunDispatchConsumer,
    usageLedger: UsageLedgerConsumer,
  ) {
    this.dispatcher = new OutboxDispatcher(db, [runDispatch, usageLedger], {
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
          `dispatch tick: claimed=${result.claimed} published=${result.published} retried=${result.retried} dead-lettered=${result.deadLettered}`,
        );
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
