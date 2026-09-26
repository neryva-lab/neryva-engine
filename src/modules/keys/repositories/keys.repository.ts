/**
 * Keys repository (P3) — the persistence port for the key/token authority
 * (`KeysService`): the Python-owned `api_keys` mirror (console key CRUD +
 * the unauthenticated key-hash validation path) and the engine-owned
 * `studio_project_keys` binding furniture (K-2).
 *
 * Two segregated interfaces by aggregate/transaction boundary:
 * - `IApiKeyRepository` — the `api_keys` row lifecycle: list/get/create/
 *   revoke/update/rotate, the unauthenticated `findByKeyHash` auth lookup,
 *   the bypass expiring-key scan, and the key.* audit-trail read.
 * - `IStudioProjectKeyRepository` — the project-key binding: idempotent
 *   bind at issue time + tenant-scoped binding read.
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every tenant method takes the organization id
 * explicitly. The PostgreSQL implementation applies it via
 * `DbService.withOrg` (+ explicit `tenant_id`/`org_id` app predicates); the
 * MongoDB implementation applies it as an explicit tenant predicate on
 * every tenant collection access (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the drizzle schema sources —
 * the interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps
 * BSON documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (name trim/length, role allow-list, scope rules,
 *   expiry-in-future, key-hash digest shape)
 * - key material generation (`nrv_live_` raw secret, SHA-256 hash, prefix)
 * - audit writes (replayed by the service from inputs + results)
 * - ephemeral event-bus emissions (`EngineEvents.KeyRevoked` is a hint,
 *   not a durable fact) and notifications
 */
import type { legacyApiKeys } from '../../../common/infra/db/legacy-schema';
import type { studioProjectKeys } from '../../studio-furniture/schema';

/** `api_keys` row (Python-owned DDL mirror); `scopes` is jsonb → unknown. */
export type ApiKeyRow = typeof legacyApiKeys.$inferSelect;
/** `studio_project_keys` binding row (engine-owned). */
export type ProjectKeyBindingRow = typeof studioProjectKeys.$inferSelect;

export interface ApiKeyCreateInput {
  /** Client-generated uuid (randomUUID) — the pg lane inserts it as-is. */
  id: string;
  orgId: string;
  name: string;
  /** SHA-256 hex of the raw `nrv_live_` secret; unique (`uq_api_keys_key_hash`). */
  keyHash: string;
  prefix: string;
  role: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyPatch {
  name?: string;
  scopes?: string[];
}

/** Narrow row for the expiring-key worker scan. */
export interface ExpiringApiKeyRow {
  id: string;
  name: string;
  tenantId: string | null;
  expiresAt: string | null;
}

/** Narrow row for the key.* audit-trail read (drizzle select shape). */
export interface ApiKeyEventRow {
  action: string;
  actor_id: string | null;
  created_at: string;
  details: unknown;
}

export interface IApiKeyRepository {
  /** Tenant-scoped key list, newest first, capped at 200 (console surface). */
  listKeys(orgId: string): Promise<ApiKeyRow[]>;

  /** Tenant-scoped row read; null when missing or owned by another org. */
  getKey(orgId: string, keyId: string): Promise<ApiKeyRow | null>;

  /**
   * Insert a key row. Throws `conflict` when the key_hash is already taken
   * (pg 23505 `uq_api_keys_key_hash` / mongo 11000) — the caller retries
   * issue with fresh key material.
   */
  createKey(input: ApiKeyCreateInput): Promise<{ id: string }>;

  /**
   * Revoke a key (soft revoke: `revoked = true`). Throws `notFound` when
   * the key is missing in this org.
   */
  revokeKey(orgId: string, keyId: string): Promise<void>;

  /**
   * Patch name and/or scopes (already validated by the caller); always
   * bumps `updated_at`. Throws `notFound` when the key is missing or
   * already revoked.
   */
  updateKey(orgId: string, keyId: string, patch: ApiKeyPatch): Promise<void>;

  /**
   * Rotation (Stripe semantics): same row, new secret hash + prefix,
   * `usage_count` reset. The old secret dies with this write. Throws
   * `notFound` when the key is missing or already revoked. Returns the
   * pre-rotation row (the caller needs `name` for its notification).
   */
  rotateKey(
    orgId: string,
    keyId: string,
    input: { keyHash: string; prefix: string },
  ): Promise<ApiKeyRow>;

  /**
   * UNAUTHENTICATED auth path — the L2 bearer-token validation lookup.
   * Lookup is by key_hash with NO tenant scope: the tenant is not known
   * until the row is read (it comes from the row's `tenant_id`). Single
   * query; latency-sensitive. Bypass by design; the caller applies the
   * revoked/expired policy on the returned row.
   */
  findByKeyHash(keyHash: string): Promise<ApiKeyRow | null>;

  /**
   * Bypass scan for the daily expiring-key worker: non-revoked keys with a
   * KNOWN expiry at or before `horizonIso` (ISO-8601). Keys with no expiry
   * never appear. Cross-org by design (the worker notifies each key's org).
   */
  scanExpiringKeys(horizonIso: string): Promise<ExpiringApiKeyRow[]>;

  /**
   * Bypass read of the `key.*` audit-event trail for one key (newest
   * first, cap 50). `audit_events` is platform-plane; the pre-extraction
   * code read it via `db.root`.
   */
  listKeyEvents(keyId: string): Promise<ApiKeyEventRow[]>;
}

export interface IStudioProjectKeyRepository {
  /**
   * Bind a key to a project at issue time (K-2). Idempotent: an existing
   * binding for the key is kept as-is (`onConflictDoNothing` on the pg
   * lane; duplicate-key swallow on the mongo lane).
   */
  bindKeyToProject(input: {
    orgId: string;
    apiKeyId: string;
    projectId: string;
    boundBy: string;
  }): Promise<void>;

  /** Tenant-scoped binding read by key id; null when unbound. */
  getBindingByKeyId(orgId: string, apiKeyId: string): Promise<ProjectKeyBindingRow | null>;
}
