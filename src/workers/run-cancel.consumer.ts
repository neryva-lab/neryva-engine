import type { OutboxEvent } from '../common/infra/outbox/schema';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { Injectable, Logger } from '@nestjs/common';
import { cancelRunOnStudio, isRuntimeConfigured } from '../transport/mcp/runtime-control.client';
import { PermanentConsumerError } from '../common/infra/outbox/consumer';

/**
 * Run cancel consumer (FL-1.3) — propagates an Engine `run.canceled` event to
 * the Studio runtime so the in-flight provider call aborts mid-stream instead
 * of running to completion. The Engine run row is already CANCELED when this
 * fires (conversations.cancelRun / approval denial); delivery here only stops
 * wasted Studio work.
 *
 * Without a configured runtime the event is consumed as an explicit no-op —
 * there is no Studio to cancel.
 */
@Injectable()
export class RunCancelConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(RunCancelConsumer.name);

  readonly name = 'run-cancel';
  readonly eventTypes = ['run.canceled'];

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      run_id?: string;
      conversation_id?: string;
      reason?: string;
    };
    const orgId = event.organizationId;
    const runId = payload.run_id ?? event.aggregateId;
    const conversationId = payload.conversation_id;
    if (!runId || !conversationId) {
      // Malformed payload — not retryable.
      throw new SkipCancelError(`run.canceled payload incomplete for run ${runId || '(unknown)'}`);
    }
    if (!isRuntimeConfigured()) {
      RunCancelConsumer.logger.debug(`runtime not configured; cancel for run ${runId} not propagated (event ${event.eventId})`);
      return;
    }
    try {
      await cancelRunOnStudio({
        organizationId: orgId,
        conversationId,
        runId,
        reason: payload.reason ?? 'canceled_by_engine',
      });
      RunCancelConsumer.logger.log(`cancel propagated to studio for run ${runId}`);
    } catch (err) {
      // Plain errors are the dispatcher's retryable class: the backoff
      // redelivers. The Engine state is already terminal, so a lost delivery
      // degrades to wasted Studio work, never wrong state.
      throw new Error(`studio cancelRun unavailable for run ${runId}: ${(err as Error).message}`);
    }
  }
}

/** Non-retryable cancel failures — event is dead-lettered. */
export class SkipCancelError extends PermanentConsumerError {}
