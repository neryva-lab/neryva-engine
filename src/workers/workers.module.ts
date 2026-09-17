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
import { ConversationsModule } from '../modules/conversations/conversations.module';
import { KnowledgeModule } from '../modules/knowledge/knowledge.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { EvalExecutorConsumer } from './eval-executor.consumer';
import { EvalScoringConsumer } from './eval-scoring.consumer';
import { HumanLoopNotifyConsumer } from './human-loop-notify.consumer';
import { RunWatchdogWorker } from './run-watchdog.worker';
import { ModelDriftWorker } from './model-drift.worker';
import { DegradedSweepWorker } from './degraded-sweep.worker';
import { AssistantsModule } from '../modules/assistants/assistants.module';

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
    // Eval plane (REL-2.1/2.2): the executor drives conversations, the
    // scoring consumer folds results into EvalService.completeRun (GAP-03).
    ...(ModuleFlags.conversations ? [ConversationsModule] : []),
    ...(ModuleFlags.knowledge ? [KnowledgeModule] : []),
    // Human-loop notifications (REL-5.2): approval/escalation fan-out.
    ...(ModuleFlags.notifications ? [NotificationsModule] : []),
    // P5: drift + degraded sweeps need EvalService (knowledge), the
    // AssistantsService suspend path, and the notification fan-out. Same
    // flag-gating as the rest: with assistants off these workers' module
    // deps are absent and Nest refuses to boot them (matching the existing
    // HumanLoopNotify/Notifications posture — flags on in the monolith).
    ...(ModuleFlags.assistants ? [AssistantsModule] : []),
  ],
  providers: [
    RunDispatchConsumer,
    TemplateProvisioningConsumer,
    RunCancelConsumer,
    AnalyticsRollupConsumer,
    MemoryProposerConsumer,
    LlmJudgeConsumer,
    EvalExecutorConsumer,
    EvalScoringConsumer,
    HumanLoopNotifyConsumer,
    OutboxDispatcherWorker,
    AcceptedRunSweepWorker,
    RunWatchdogWorker,
    ModelDriftWorker,
    DegradedSweepWorker,
  ],
  exports: [OutboxDispatcherWorker],
})
export class WorkersModule {}
