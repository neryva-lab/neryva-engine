import { Injectable, Logger } from '@nestjs/common';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { UsageLedgerService } from '../modules/billing/usage-ledger.service';

/**
 * Usage ledger consumer — Phase 8.5 wiring: terminal run outcomes land in
 * the immutable ledger via the outbox (same delivery guarantees as every
 * other durable fact). One entry per completed run with `usage_kind=runs`;
 * token/cost metering enriches this via the metering ingest path, which
 * carries provider/model detail.
 */
@Injectable()
export class UsageLedgerConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(UsageLedgerConsumer.name);

  readonly name = 'usage-ledger';
  readonly eventTypes = ['run.completed'];

  constructor(private readonly ledger: UsageLedgerService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { run_id?: string; conversation_id?: string; message_id?: string };
    const runId = payload.run_id ?? event.aggregateId;
    await this.ledger.append({
      orgId: event.organizationId,
      usageEventId: `run-completed:${runId}`,
      sourceType: 'engine',
      sourceId: event.eventId,
      runId,
      messageId: payload.message_id,
      usageKind: 'runs',
      unit: 'count',
      quantity: 1,
      metadata: { delivered_by: 'outbox', event_id: event.eventId },
    });
    UsageLedgerConsumer.logger.debug(`usage ledger entry recorded for run ${runId}`);
  }
}
