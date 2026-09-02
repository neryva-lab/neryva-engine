import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outboxEvents } from './schema';
import { uuidv7 } from '../../ids/uuidv7';

/**
 * Outbox writer — the ONLY sanctioned way to enqueue a durable event.
 * Must be called with the SAME transaction that writes the canonical fact
 * (invariant 7): never wrap in its own transaction, never fire-and-forget.
 */
export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  eventType: string;
  eventVersion?: number;
  payload?: Record<string, unknown>;
  /** Ordering/fan-out key — per-aggregate (conversation_id/run_id), not global. */
  partitionKey: string;
  traceId?: string;
  correlationId?: string;
}

export async function recordOutboxEvent(tx: NodePgDatabase, input: OutboxEventInput): Promise<void> {
  await tx.insert(outboxEvents).values({
    eventId: uuidv7(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    organizationId: input.organizationId,
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    payload: input.payload ?? null,
    partitionKey: input.partitionKey,
    status: 'PENDING',
    traceId: input.traceId ?? null,
    correlationId: input.correlationId ?? null,
  });
}
