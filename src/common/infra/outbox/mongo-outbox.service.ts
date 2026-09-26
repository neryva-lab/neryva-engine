import type { Db } from 'mongodb';
import type { MongoTxContext } from '../db/mongo/mongo-tx';
import { uuidToBinary } from '../db/mongo/mongo-tx';
import { uuidv7 } from '../../ids/uuidv7';

/**
 * MongoDB outbox writer — the ONLY sanctioned way to enqueue a durable event
 * on the mongo lane. Must be called with the SAME transaction context that
 * writes the canonical fact (invariant 7): never wrap in its own transaction,
 * never fire-and-forget.
 *
 * Mirrors `recordOutboxEvent` in `outbox.service.ts` (postgres lane) against
 * `outboxEvents` in `outbox/schema.ts`:
 * - `event_id` is the primary key (BSON binary subtype 4, plan D4), required
 *   by the collection validator and the `pk_outbox_events` unique index.
 * - `aggregate_id` / `organization_id` / `correlation_id` are UUIDs, stored
 *   as binary subtype 4 exactly like the pg `uuid` columns.
 * - `attempt_count: 0` and `next_attempt_at: now` are set explicitly: mongo
 *   has no column defaults, and the dispatcher claims on
 *   `status IN (PENDING, RETRY_WAIT) AND next_attempt_at <= now()` — omitting
 *   `next_attempt_at` would silently starve the event from dispatch.
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
  mongo: { root: Db },
  input: MongoOutboxEventInput,
): Promise<void> {
  const now = new Date();
  await mongo.root.collection('outbox_events').insertOne(
    {
      event_id: uuidToBinary(uuidv7()),
      aggregate_type: input.aggregateType,
      aggregate_id: uuidToBinary(input.aggregateId),
      organization_id: uuidToBinary(input.organizationId),
      event_type: input.eventType,
      event_version: input.eventVersion ?? 1,
      payload: input.payload ?? null,
      partition_key: input.partitionKey,
      status: 'PENDING',
      attempt_count: 0,
      next_attempt_at: now,
      trace_id: input.traceId ?? null,
      correlation_id: input.correlationId ? uuidToBinary(input.correlationId) : null,
      created_at: now,
      published_at: null,
      claimed_at: null,
      last_error: null,
    },
    { session: ctx.session },
  );
}
