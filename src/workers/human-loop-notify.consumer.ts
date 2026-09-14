import { Injectable, Logger } from '@nestjs/common';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import { NotificationsService } from '../modules/notifications/notifications.service';

/**
 * Human-in-the-loop notifications — REL-5.2 (release_ledger.md), GAP-08:
 * approvals and escalations were created silently; nobody was ever told.
 * Both creation sites already emit durable outbox events inside their
 * transactions (`approval.requested`, `conversation.escalated`), so this
 * consumer only FAN-OUTS: in-app notifications to the org's owner/admin
 * roles via NotificationsService.notifyOrgRoles (never throws — the
 * notification plane degrades independently of the durable fact).
 *
 * Exactly-once per event comes free from the dispatcher's inbox dedup.
 */
@Injectable()
export class HumanLoopNotifyConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(HumanLoopNotifyConsumer.name);

  readonly name = 'human-loop-notify';
  readonly eventTypes = ['approval.requested', 'conversation.escalated'];

  constructor(private readonly notifications: NotificationsService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { run_id?: string; approval_ref?: string; summary?: string; conversation_id?: string };
    if (event.eventType === 'approval.requested') {
      const summary = String(payload.summary ?? 'an action is waiting for approval').slice(0, 200);
      await this.notifications.notifyOrgRoles(event.organizationId, ['owner', 'admin'], {
        kind: 'approval.requested',
        severity: 'warn',
        title: `Approval needed: ${summary}`,
        body: payload.approval_ref
          ? `Run ${payload.run_id ?? ''} requested approval (${payload.approval_ref}). Decide from the approvals queue before it expires.`
          : `Run ${payload.run_id ?? ''} requested approval. Decide from the approvals queue before it expires.`,
        data: { run_id: payload.run_id ?? null, approval_ref: payload.approval_ref ?? null },
      });
      HumanLoopNotifyConsumer.logger.debug(`approval notification fanned out for run ${payload.run_id ?? event.aggregateId}`);
      return;
    }
    // conversation.escalated — the human queue grew; owners/admins should claim.
    await this.notifications.notifyOrgRoles(event.organizationId, ['owner', 'admin'], {
      kind: 'escalation.created',
      severity: 'warn',
      title: 'New escalation waiting to be claimed',
      body: `Conversation ${payload.conversation_id ?? event.aggregateId} moved to the human queue.`,
      data: { conversation_id: payload.conversation_id ?? event.aggregateId },
    });
    HumanLoopNotifyConsumer.logger.debug(`escalation notification fanned out for conversation ${payload.conversation_id ?? event.aggregateId}`);
  }
}
