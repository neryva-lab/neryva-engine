import { Module } from '@nestjs/common';
import { OutboxDispatcherWorker } from './outbox-dispatcher.worker';
import { RunDispatchConsumer } from './run-dispatch.consumer';
import { UsageLedgerConsumer } from './usage-ledger.consumer';

/**
 * Worker module — Phase 6.6 worker families live here (bounded concurrency,
 * per-tenant fairness via the dispatcher's FIFO batch). Runs inside the
 * monolith; role split at deploy time does not change this module.
 */
@Module({
  providers: [RunDispatchConsumer, UsageLedgerConsumer, OutboxDispatcherWorker],
  exports: [OutboxDispatcherWorker],
})
export class WorkersModule {}
