import { Module } from '@nestjs/common';
import { OutboxDispatcherWorker } from './outbox-dispatcher.worker';
import { RunDispatchConsumer } from './run-dispatch.consumer';
import { RunCancelConsumer } from './run-cancel.consumer';
import { UsageLedgerConsumer } from './usage-ledger.consumer';
import { AcceptedRunSweepWorker } from './accepted-run-sweep.worker';
import { ReEmbedWorker } from './reembed.worker';
import { MemoryProposerConsumer } from './memory-proposer.consumer';
import { LlmJudgeConsumer } from './llm-judge.consumer';
import { LifecycleWebhookConsumer } from './lifecycle-webhook.consumer';
import { AnalyticsRollupConsumer } from './analytics-rollup.consumer';
import { ModuleFlags } from '../common/config/feature-flags';
import { ChannelsModule } from '../modules/channels/channels.module';

/**
 * Worker module — Phase 6.6 worker families live here (bounded concurrency,
 * per-tenant fairness via the dispatcher's FIFO batch). Runs inside the
 * monolith; role split at deploy time does not change this module.
 */
@Module({
  // The channels consumers (ingest/outbound) join the dispatcher only when
  // the channel plane is enabled — the worker registry is the composition
  // point for every outbox consumer.
  imports: [...(ModuleFlags.channels ? [ChannelsModule] : [])],
  providers: [RunDispatchConsumer, RunCancelConsumer, UsageLedgerConsumer, AnalyticsRollupConsumer, LifecycleWebhookConsumer, MemoryProposerConsumer, LlmJudgeConsumer, OutboxDispatcherWorker, AcceptedRunSweepWorker, ReEmbedWorker],
  exports: [OutboxDispatcherWorker],
})
export class WorkersModule {}
