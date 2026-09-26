/**
 * Shared MongoDB document shapes + row mappers for the webhooks-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * `org_id` is a pg `varchar(36)` holding UUID strings (same posture as the
 * billing lane's `org_id`): on the mongo lane it is stored as Binary subtype
 * 4, and `tenantCollection` below pins the `TenantScopedCollection` tenant
 * field to `org_id` (the default `organization_id` does not exist here).
 */
import type { Binary, Db, Document } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { WebhookDeliveryRow, WebhookRow } from '../schema';

/** Tenant-guarded handle for a webhooks-plane collection (tenant field `org_id`). */
export function tenantCollection<T extends Document>(db: Db, name: string): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name), { tenantField: 'org_id' });
}

/** True for MongoDB duplicate-key errors (the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

export function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

// ── webhooks ────────────────────────────────────────────────────────────────

export interface WebhookMongoDoc {
  id: Binary;
  org_id: Binary;
  events: string[];
  url: string;
  secret_envelope: string;
  description: string | null;
  status: string;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export function toWebhook(doc: WebhookMongoDoc): WebhookRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    events: doc.events,
    url: doc.url,
    secretEnvelope: doc.secret_envelope,
    description: doc.description,
    status: doc.status,
    createdBy: doc.created_by ? uuidOf(doc.created_by) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── webhook_deliveries ──────────────────────────────────────────────────────

export interface WebhookDeliveryMongoDoc {
  id: Binary;
  org_id: Binary;
  webhook_id: Binary;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  response_status: number | null;
  delivered_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toWebhookDelivery(doc: WebhookDeliveryMongoDoc): WebhookDeliveryRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    webhookId: uuidOf(doc.webhook_id),
    eventType: doc.event_type,
    payload: doc.payload,
    status: doc.status,
    attempts: doc.attempts,
    lastError: doc.last_error,
    responseStatus: doc.response_status,
    deliveredAt: doc.delivered_at,
    nextAttemptAt: doc.next_attempt_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── webhook_delivery_claims (sweep-claim link collection) ───────────────────
//
// The stranded-delivery claim's mutual-exclusion marker. The delivery row's
// state machine (`pending/failed/delivered/dead`) is pg-schema-owned and has
// no claim column — and the mongo `0001_engine_core` migration is
// checksum-pinned, so no new field or index can be added there. The claim
// therefore lives in this link collection (the same claim-before-send
// pattern the channels plane uses via `channel_message_links`):
// `{ org_id, delivery_id }` is unique, so of any set of overlapping
// claimants exactly one insert wins per row. `expires_at` (TTL) is purely a
// crash backstop — claims are released at the end of the claim unit.
export interface WebhookDeliveryClaimDoc {
  org_id: Binary;
  delivery_id: Binary;
  claimed_at: string;
  expires_at: Date;
}
