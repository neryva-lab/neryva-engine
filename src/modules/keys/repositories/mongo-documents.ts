/**
 * Shared MongoDB document shapes + row mappers for the keys-module mongo
 * repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Note on the `api_keys` mirror: the pg columns `id`/`tenant_id` are
 * `varchar(36)` (Python-owned DDL), but every value the engine writes is a
 * UUID string (randomUUID / org ids), so they are stored as Binary subtype 4
 * here per plan D4 — exactly what the mongo baseline migration's validator
 * describes ("UUIDs are stored per plan D4 (BSON binary subtype 4)"). The
 * tenant choke point (`TenantScopedCollection`) normalizes a string orgId
 * to Binary, so the stored tenant value must be Binary for the predicate
 * to match; `tenant_id` is nullable on pg (`tenant_id: Binary | null`).
 */
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  ApiKeyEventRow,
  ApiKeyRow,
  ExpiringApiKeyRow,
  ProjectKeyBindingRow,
} from './keys.repository';

/** Tenant-guarded handle for a collection (plan D6 — explicit org predicate). */
export function tenantCollection<T extends Document>(
  db: Db,
  name: string,
  opts?: { tenantField?: string },
): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name), opts);
}

/** True for MongoDB duplicate-key errors (plan D7: the 11000 claim-loss signal). */
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

// ── api_keys ──────────────────────────────────────────────────────────────

export interface ApiKeyMongoDoc {
  id: Binary;
  name: string;
  key_hash: string;
  prefix: string;
  role: string;
  tenant_id: Binary | null;
  scopes: unknown;
  expires_at: string | null;
  revoked: boolean;
  last_used_at: string | null;
  usage_count: number;
  mfa_secret: string | null;
  mfa_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function toApiKeyRow(doc: WithId<ApiKeyMongoDoc>): ApiKeyRow {
  return {
    id: uuidOf(doc.id),
    name: doc.name,
    key_hash: doc.key_hash,
    prefix: doc.prefix,
    role: doc.role,
    tenant_id: doc.tenant_id ? uuidOf(doc.tenant_id) : null,
    scopes: doc.scopes,
    expires_at: doc.expires_at,
    revoked: doc.revoked,
    last_used_at: doc.last_used_at,
    usage_count: doc.usage_count,
    mfa_secret: doc.mfa_secret,
    mfa_enabled: doc.mfa_enabled,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

/** Narrow projection for the expiring-key worker scan. */
export interface ExpiringApiKeyMongoDoc {
  id: Binary;
  name: string;
  tenant_id: Binary | null;
  expires_at: string | null;
}

export function toExpiringApiKeyRow(doc: ExpiringApiKeyMongoDoc): ExpiringApiKeyRow {
  return {
    id: uuidOf(doc.id),
    name: doc.name,
    tenantId: doc.tenant_id ? uuidOf(doc.tenant_id) : null,
    expiresAt: doc.expires_at,
  };
}

// ── studio_project_keys ───────────────────────────────────────────────────

export interface StudioProjectKeyMongoDoc {
  id: Binary;
  org_id: Binary;
  api_key_id: Binary;
  project_id: Binary;
  bound_by: Binary;
  created_at: string;
}

export function toProjectKeyBindingRow(doc: WithId<StudioProjectKeyMongoDoc>): ProjectKeyBindingRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    apiKeyId: uuidOf(doc.api_key_id),
    projectId: uuidOf(doc.project_id),
    boundBy: uuidOf(doc.bound_by),
    createdAt: doc.created_at,
  };
}

// ── audit_events (key.* trail read only) ──────────────────────────────────

export interface KeyEventMongoDoc {
  action: string;
  actor_id: string | null;
  resource_id: string | null;
  created_at: string;
  details: unknown;
}

export function toApiKeyEventRow(doc: KeyEventMongoDoc): ApiKeyEventRow {
  return {
    action: doc.action,
    actor_id: doc.actor_id,
    created_at: doc.created_at,
    details: doc.details,
  };
}

/**
 * Defensive unique-index ensurement for the keys writes (plan D7). Mirrors
 * the PostgreSQL unique constraints the pg lane depends on (`api_keys`
 * `uq_api_keys_key_hash`, `studio_project_keys` `uq_studio_project_keys_key`);
 * the migration registry owns these, so the repository ensures them
 * defensively here. Idempotent — `createIndex` with the same name and spec
 * is a no-op.
 */
const ensuredDatabases = new WeakSet<Db>();

export async function ensureKeysIndexes(db: Db): Promise<void> {
  if (ensuredDatabases.has(db)) return;
  await db.collection('api_keys').createIndex({ key_hash: 1 }, { unique: true, name: 'uq_api_keys_key_hash' });
  await db.collection('studio_project_keys').createIndex(
    { org_id: 1, api_key_id: 1 },
    { unique: true, name: 'uq_studio_project_keys_key' },
  );
  ensuredDatabases.add(db);
}
