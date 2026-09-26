/**
 * Shared MongoDB document shapes + row mappers for the notifications-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 */
import type { Binary, Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { Notification, NotificationSeverity } from './notification.repository';

/** Tenant-guarded handle for a collection (explicit org predicate). */
export function tenantCollection<T extends Document>(
  db: import('mongodb').Db,
  name: string,
): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name));
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

// ── notifications ───────────────────────────────────────────────────────────

export interface NotificationMongoDoc {
  id: Binary;
  account_id: Binary;
  org_id: string | null;
  kind: string;
  severity: string;
  title: string;
  body: string;
  data: unknown;
  read_at: string | null;
  created_at: string;
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

export function toNotification(doc: WithId<NotificationMongoDoc>): Notification {
  return {
    id: uuidOf(doc.id),
    accountId: uuidOf(doc.account_id),
    orgId: doc.org_id,
    kind: doc.kind,
    severity: doc.severity as NotificationSeverity,
    title: doc.title,
    body: doc.body,
    data: (doc.data ?? {}) as Record<string, unknown>,
    readAt: doc.read_at,
    createdAt: doc.created_at,
  };
}
