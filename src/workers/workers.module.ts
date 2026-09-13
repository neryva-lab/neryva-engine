import { Module } from '@nestjs/common';
import { OutboxDispatcherWorker } from './outbox-dispatcher.worker';
import { RunDispatchConsumer } from './run-dispatch.consumer';
import { TemplateProvisioningConsumer } from './template-provisioning.consumer';
import { RunCancelConsumer } from './run-cancel.consumer';
import { AcceptedRunSweepWorker } from './accepted-run-sweep.worker';
import { MemoryProposerConsumer } from './memory-proposer.consumer';
import { LlmJudgeConsumer } from './llm-judge.consumer';
import { AnalyticsRollupConsumer } from './analytics-rollup.consumer';
import { ModuleFlags } from '../common/config/feature-flags';
import { ChannelsModule } from '../modules/channels/channels.module';
import { BillingModule } from '../modules/billing/billing.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';

/**
 * Worker module — Phase 6.6 worker families live here (bounded concurrency,
 * per-tenant fairness via the dispatcher's FIFO batch). Runs inside the
 * monolith; role split at deploy time does not change this module.
 */
@Module({
  // Domain-owned consumers join the dispatcher only when their feature module
  // is loaded: channels (ingest/outbound), billing (usage ledger), webhooks
  // (lifecycle notifications). The feature modules export those consumers, so
  // WITHOUT these imports the @Optional() @Inject(class) tokens in the
  // dispatcher resolve to undefined EVEN WHEN the flags are on — consumers
  // would be silently dropped. The flags keep both sides in the same states.
  imports: [
    ...(ModuleFlags.channels ? [ChannelsModule] : []),
    ...(ModuleFlags.billing ? [BillingModule] : []),
    ...(ModuleFlags.webhooks ? [WebhooksModule] : []),
  ],
  providers: [RunDispatchConsumer, TemplateProvisioningConsumer, RunCancelConsumer, AnalyticsRollupConsumer, MemoryProposerConsumer, LlmJudgeConsumer, OutboxDispatcherWorker, AcceptedRunSweepWorker],
  exports: [OutboxDispatcherWorker],
})
export class WorkersModule {}
