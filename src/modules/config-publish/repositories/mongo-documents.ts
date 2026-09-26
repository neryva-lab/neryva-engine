/**
 * Shared MongoDB document shapes + row mappers for the config-publish-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Tenant key on this module's tables is `org_id` (varchar(36) matching the
 * Python-owned tenants.id — the org-furniture group), so every
 * `TenantScopedCollection` here is constructed with
 * `{ tenantField: 'org_id' }`. `config_notifications` is platform-plane by
 * design (drizzle 0007: "satellites and config_notifications are
 * platform-plane — no RLS") and goes through `PlatformCollection`.
 */
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { ConfigDraft, PublishedConfig } from '../config-publish.schema';
import type { ConfigNotification } from './config-publish.repository';

/**
 * Tenant-guarded handle for a config-publish collection (plan D6 — explicit
 * `org_id` predicate, the org-furniture tenant-field group).
 */
export function tenantCollection<T extends Document>(db: Db, name: string): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name), { tenantField: 'org_id' });
}

/** True for MongoDB duplicate-key errors (plan D7: the 11000 race signal). */
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

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

// ── published_configs ──────────────────────────────────────────────────────

export interface PublishedConfigMongoDoc {
  id: Binary;
  org_id: Binary;
  scope: string;
  product: string | null;
  version: number;
  payload: unknown;
  payload_hash: string;
  notes: string | null;
  rollback_of: number | null;
  published_by: string;
  published_at: string;
}

export function toPublishedConfig(doc: PublishedConfigMongoDoc): PublishedConfig {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    scope: doc.scope,
    product: doc.product,
    version: doc.version,
    payload: doc.payload,
    payloadHash: doc.payload_hash,
    notes: doc.notes,
    rollbackOf: doc.rollback_of,
    publishedBy: doc.published_by,
    publishedAt: doc.published_at,
  };
}

// ── config_drafts ──────────────────────────────────────────────────────────

export interface ConfigDraftMongoDoc {
  id: Binary;
  org_id: Binary;
  scope: string;
  product: string | null;
  payload: unknown;
  payload_hash: string;
  validation_status: string;
  validation_issues: unknown;
  notes: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export function toConfigDraft(doc: ConfigDraftMongoDoc): ConfigDraft {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    scope: doc.scope,
    product: doc.product,
    payload: doc.payload,
    payloadHash: doc.payload_hash,
    validationStatus: doc.validation_status,
    validationIssues: doc.validation_issues,
    notes: doc.notes,
    createdBy: doc.created_by,
    updatedBy: doc.updated_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── config_notifications (platform-plane) ──────────────────────────────────

export interface ConfigNotificationMongoDoc {
  config_id: Binary;
  satellite_key: string;
  notified_at: string;
  acked_at: string | null;
}

export function toConfigNotification(doc: ConfigNotificationMongoDoc): ConfigNotification {
  return {
    configId: uuidOf(doc.config_id),
    satelliteKey: doc.satellite_key,
    notifiedAt: doc.notified_at,
    ackedAt: doc.acked_at,
  };
}
