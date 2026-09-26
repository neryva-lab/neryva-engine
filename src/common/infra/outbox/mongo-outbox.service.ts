import type { MongoTxContext } from '../db/mongo/mongo-tx';
import { uuidToBinary } from '../db/mongo/mongo-tx';
import { uuidv7 } from '../../ids/uuidv7';

/**
 * MongoDB outbox writer — the ONLY sanctioned way to enqueue a durable event
 * on the mongo lane. Must be called with the SAME transaction context that
 * writes the canonical fact (invariant 7): never wrap in its own transaction,
 * never fire-and-forget.
 *
 * Mirrors `recordOutboxEvent` in `outbox.service.ts` (postgres lane).
 */
export interface MongoOutboxEventInput {
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

export async function recordMongoOutboxEvent(
  ctx: MongoTxContext,
  mongo: { root: import('mongodb').Db },
  input: MongoOutboxEventInput,
): Promise<void> {
  const now = new Date();
  await mongo.root.collection('outbox_events').insertOne(
    {
      id: uuidToBinary(uuidv7()),
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      organization_id: uuidToBinary(input.organizationId),
      event_type: input.eventType,
      event_version: input.eventVersion ?? 1,
      payload: input.payload ?? null,
      partition_key: input.partitionKey,
      status: 'PENDING',
      trace_id: input.traceId ?? null,
      correlation_id: input.correlationId ?? null,
      created_at: now,
      updated_at: now,
    },
    { session: ctx.session },
  );
}
