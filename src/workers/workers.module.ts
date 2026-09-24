import { Module } from '@nestjs/common';
import { OutboxDispatcherWorker } from './outbox-dispatcher.worker';
import { ApprovalExpirySweepWorker } from './approval-expiry-sweep.worker';
import { WebhookDeliverySweepWorker } from './webhook-delivery-sweep.worker';
import { RunDispatchConsumer } from './run-dispatch.consumer';
import { TemplateProvisioningConsumer } from './template-provisioning.consumer';
import { RunCancelConsumer } from './run-cancel.consumer';
import { AcceptedRunSweepWorker } from './accepted-run-sweep.worker';
import { MemoryProposerConsumer } from './memory-proposer.consumer';
import { LlmJudgeConsumer } from './llm-judge.consumer';
import { AnalyticsRollupConsumer } from './analytics-rollup.consumer';
import { ModuleFlags } from '../common/config/feature-flags';
import { env } from '../common/config/env';
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
    // Flag-gated consumers/workers — same flags as the module imports above.
    // Registering them unconditionally crashes Nest at boot when their
    // feature module is disabled (Conversations/Notifications/Eval/
    // Assistants services are not in the DI graph then). The dispatcher's
    // @Optional() @Inject(class) tokens resolve to undefined for absent
    // providers and the consumer is simply skipped — no degraded mode, the
    // events that feed them cannot exist with the module off.
    // Eval plane (REL-2.1/2.2): executor drives conversations (GAP-03),
    // scoring folds terminal run events into EvalService.completeRun.
    ...(ModuleFlags.conversations ? [EvalExecutorConsumer] : []),
    ...(ModuleFlags.knowledge ? [EvalScoringConsumer] : []),
    // Human-loop notifications (REL-5.2): approval/escalation fan-out.
    ...(ModuleFlags.notifications ? [HumanLoopNotifyConsumer] : []),
    // Approval-expiry sweep (Wave 4 GAP 1): only when conversations are on and
    // both the outbox dispatcher and the sweep itself are enabled. The sweep
    // writes run.canceled outbox events that only the dispatcher delivers.
    ...(ModuleFlags.conversations && env.WORKERS__OUTBOX_ENABLED && env.WORKERS__APPROVAL_EXPIRY_ENABLED
      ? [ApprovalExpirySweepWorker]
      : []),
    OutboxDispatcherWorker,
    AcceptedRunSweepWorker,
    // Webhook-delivery sweep (P5-W13): re-queues stranded delivery rows so
    // every durable side effect keeps a reconciliation path. Needs the
    // webhooks module (WebhooksService) and the dispatcher-adjacent worker
    // host to be enabled.
    ...(ModuleFlags.webhooks && env.WORKERS__OUTBOX_ENABLED && env.WORKERS__WEBHOOK_SWEEP_ENABLED
      ? [WebhookDeliverySweepWorker]
      : []),
    // Run watchdog resolves conversations (accept/retry bookkeeping).
    ...(ModuleFlags.conversations ? [RunWatchdogWorker] : []),
    // P5: drift needs EvalService (knowledge) + notification fan-out; the
    // degraded sweep needs the AssistantsService suspend path + fan-out.
    ...(ModuleFlags.knowledge && ModuleFlags.notifications ? [ModelDriftWorker] : []),
    ...(ModuleFlags.assistants && ModuleFlags.notifications ? [DegradedSweepWorker] : []),
  ],
  exports: [OutboxDispatcherWorker],
})
export class WorkersModule {}
