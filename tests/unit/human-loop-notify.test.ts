import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HumanLoopNotifyConsumer } from '../../src/workers/human-loop-notify.consumer';
import type { NotificationsService } from '../../src/modules/notifications/notifications.service';
import type { OutboxEvent } from '../../src/common/infra/outbox/schema';

/**
 * REL-5.4 unit lane — the human-loop fan-out contract. The consumer is pure
 * routing over `notifyOrgRoles`: it never throws, never reads the database,
 * and shapes one notification per event. The DB-backed half (escalation
 * lifecycle, cross-tenant denial, approvals RLS) lives in
 * tests/integration/human-loop.test.ts (db-suites lane); dispatcher-level
 * redelivery dedup is covered by tests/integration/outbox.test.ts.
 */

interface DeliveredNote {
  kind: string;
  severity: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

function stubNotifs() {
  const delivered: Array<{ orgId: string; roles: string[]; note: DeliveredNote }> = [];
  const service = {
    notifyOrgRoles: async (orgId: string, roles: string[], note: DeliveredNote): Promise<void> => {
      delivered.push({ orgId, roles, note });
    },
  };
  return { delivered, service: service as unknown as NotificationsService };
}

function baseEvent(overrides: Partial<OutboxEvent>): OutboxEvent {
  return {
    eventId: randomUUID(),
    aggregateType: 'run',
    aggregateId: randomUUID(),
    organizationId: randomUUID(),
    eventType: 'approval.requested',
    eventVersion: 1,
    payload: {},
    partitionKey: 'test',
    status: 'PENDING',
    attemptCount: 0,
    nextAttemptAt: new Date().toISOString(),
    traceId: null,
    correlationId: null,
    createdAt: new Date().toISOString(),
    publishedAt: null,
    claimedAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('HumanLoopNotifyConsumer fan-out (REL-5.2/5.4)', () => {
  it('routes approval.requested to owner/admin with the approval reference', async () => {
    const { delivered, service } = stubNotifs();
    const consumer = new HumanLoopNotifyConsumer(service);
    const orgId = randomUUID();
    const runId = randomUUID();
    await consumer.handle(
      baseEvent({
        organizationId: orgId,
        payload: { run_id: runId, approval_ref: 'appr-1', summary: 'refund $42' },
      }),
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].orgId).toBe(orgId);
    expect(delivered[0].roles).toEqual(['owner', 'admin']);
    expect(delivered[0].note.kind).toBe('approval.requested');
    expect(delivered[0].note.title).toContain('refund $42');
    expect(delivered[0].note.data).toMatchObject({ run_id: runId, approval_ref: 'appr-1' });
  });

  it('truncates long approval summaries to 200 chars', async () => {
    const { delivered, service } = stubNotifs();
    const consumer = new HumanLoopNotifyConsumer(service);
    await consumer.handle(baseEvent({ payload: { run_id: randomUUID(), summary: 's'.repeat(500) } }));
    expect(delivered[0].note.title.length).toBeLessThanOrEqual('Approval needed: '.length + 200);
  });

  it('routes conversation.escalated to the human-queue notification', async () => {
    const { delivered, service } = stubNotifs();
    const consumer = new HumanLoopNotifyConsumer(service);
    const conversationId = randomUUID();
    await consumer.handle(
      baseEvent({ eventType: 'conversation.escalated', aggregateType: 'conversation', payload: { conversation_id: conversationId } }),
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].note.kind).toBe('escalation.created');
    expect(delivered[0].note.data).toMatchObject({ conversation_id: conversationId });
  });

  it('delivers exactly one notification per handle call (exactly-once comes from the dispatcher inbox)', async () => {
    const { delivered, service } = stubNotifs();
    const consumer = new HumanLoopNotifyConsumer(service);
    const event = baseEvent({ payload: { run_id: randomUUID(), summary: 'x' } });
    await consumer.handle(event);
    await consumer.handle(event);
    // Two deliveries: the consumer is at-least-once by contract — the
    // dispatcher's inbox dedup (consumer+event_id) is what makes redelivery
    // safe, covered in tests/integration/outbox.test.ts.
    expect(delivered).toHaveLength(2);
  });
});
