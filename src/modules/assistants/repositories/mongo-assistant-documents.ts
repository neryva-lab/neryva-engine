/**
 * Shared Mongo document types and mappers for the assistants module —
 * module-internal.
 *
 * BSON keys are snake_case and mirror the PostgreSQL column names exactly
 * (plan D4); UUIDs are BSON Binary subtype 4. Timestamps are ISO-8601
 * strings in `Date.toISOString()` format (millis + `Z`), matching the
 * PostgreSQL lane's `mode: 'string'` timestamptz columns — a single format
 * keeps lexicographic `$lt`/`$gt` comparisons correct.
 *
 * NOTE on the requested helper names: `src/common/infra/db/mongo/mongo-tx.ts`
 * exports `uuidToBinary` and `nowIso`, not `binUuid`/`uuidOf`. This module
 * uses `uuidToBinary` directly and defines the small local helpers it needs
 * (`binToUuid`, `binOrNull`, `nowIsoString`, `isDuplicateKeyError`) here.
 */
import type { Binary, ObjectId } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { ApiError } from '../../../common/http/api-error';
import type { Assistant, AssistantVersion, PolicySnapshot } from '../schema';

export { uuidToBinary };

/**
 * UUID string → BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error (same convention as the
 * conversations lane's local `binUuid`).
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** Binary subtype-4 UUID → canonical uuid string. */
export function binToUuid(value: Binary): string {
  return value.toUUID().toString();
}

/** Nullable Binary subtype-4 UUID → uuid string | null. */
export function binOrNull(value: Binary | null | undefined): string | null {
  return value ? binToUuid(value) : null;
}

/**
 * Timestamp in the lane's canonical string format — identical to the
 * PostgreSQL lane's `new Date().toISOString()` writes.
 */
export function nowIsoString(date: Date = new Date()): string {
  return date.toISOString();
}

/** MongoDB duplicate-key error (code 11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

/**
 * Org-name conflict — mirrors the pg `mapAssistantUniqueViolation`
 * `uq_assistants_org_name` branch byte-for-byte (message + details).
 */
export function assistantNameConflict(name: string): ApiError {
  return ApiError.conflict(
    'assistant name already taken in this organization — supply a distinct name',
    { name },
  );
}

/**
 * Draft-sentinel conflict — mirrors the pg `mapAssistantUniqueViolation`
 * `uq_assistant_versions_assistant_version` branch byte-for-byte.
 */
export function draftExistsConflict(): ApiError {
  return ApiError.conflict(
    'a draft version already exists for this assistant — publish or delete it before drafting another',
    { reason: 'draft_exists' },
  );
}

// ── assistants ───────────────────────────────────────────────────────────

export interface AssistantMongoDoc {
  _id?: ObjectId;
  id: Binary;
  organization_id: Binary;
  name: string;
  description: string | null;
  active_version_id: Binary | null;
  disabled_at: string | null;
  disabled_by: string | null;
  disabled_reason: string | null;
  degraded_until: string | null;
  degraded_reason: string | null;
  degraded_alerted_at: string | null;
  /** TTL worker-claim marker (mongo lane only — the pg lane uses row locks). */
  degraded_claimed_until?: string | null;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export function toAssistant(doc: AssistantMongoDoc): Assistant {
  return {
    id: binToUuid(doc.id),
    organizationId: binToUuid(doc.organization_id),
    name: doc.name,
    description: doc.description,
    activeVersionId: binOrNull(doc.active_version_id),
    disabledAt: doc.disabled_at,
    disabledBy: doc.disabled_by,
    disabledReason: doc.disabled_reason,
    degradedUntil: doc.degraded_until,
    degradedReason: doc.degraded_reason,
    degradedAlertedAt: doc.degraded_alerted_at,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── assistant_versions ───────────────────────────────────────────────────

export interface AssistantVersionMongoDoc {
  _id?: ObjectId;
  id: Binary;
  assistant_id: Binary;
  organization_id: Binary;
  version: number;
  schema_version: number;
  status: string;
  model_policy: unknown;
  context_policy: unknown;
  tool_policy: unknown;
  knowledge_policy: unknown | null;
  guardrail_policy: unknown;
  instructions: string | null;
  model_params: unknown | null;
  budget_policy: unknown | null;
  brand: string | null;
  rollback_of: Binary | null;
  parent_version_id: Binary | null;
  hash: string;
  published_at: string | null;
  published_by: string | null;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export function toAssistantVersion(doc: AssistantVersionMongoDoc): AssistantVersion {
  return {
    id: binToUuid(doc.id),
    assistantId: binToUuid(doc.assistant_id),
    organizationId: binToUuid(doc.organization_id),
    version: doc.version,
    schemaVersion: doc.schema_version,
    status: doc.status,
    modelPolicy: doc.model_policy,
    contextPolicy: doc.context_policy,
    toolPolicy: doc.tool_policy,
    knowledgePolicy: doc.knowledge_policy,
    guardrailPolicy: doc.guardrail_policy,
    instructions: doc.instructions,
    modelParams: doc.model_params,
    budgetPolicy: doc.budget_policy,
    brand: doc.brand,
    rollbackOf: binOrNull(doc.rollback_of),
    parentVersionId: binOrNull(doc.parent_version_id),
    hash: doc.hash,
    publishedAt: doc.published_at,
    publishedBy: doc.published_by,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── policy_snapshots ─────────────────────────────────────────────────────

export interface PolicySnapshotMongoDoc {
  _id?: ObjectId;
  id: Binary;
  organization_id: Binary;
  assistant_version_id: Binary;
  snapshot_version: number;
  model_policy: unknown;
  context_policy: unknown;
  tool_policy: unknown;
  guardrail_policy: unknown;
  knowledge_policy: unknown | null;
  instructions: string | null;
  model_params: unknown | null;
  budget_policy: unknown | null;
  brand: string | null;
  hash: string;
  tool_bindings: unknown;
  knowledge_pins: unknown;
  model_ref: unknown;
  template_ref: unknown | null;
  manifest_hash: string | null;
  created_at: string;
}

export function toPolicySnapshot(doc: PolicySnapshotMongoDoc): PolicySnapshot {
  return {
    id: binToUuid(doc.id),
    organizationId: binToUuid(doc.organization_id),
    assistantVersionId: binToUuid(doc.assistant_version_id),
    snapshotVersion: doc.snapshot_version,
    modelPolicy: doc.model_policy,
    contextPolicy: doc.context_policy,
    toolPolicy: doc.tool_policy,
    guardrailPolicy: doc.guardrail_policy,
    knowledgePolicy: doc.knowledge_policy,
    instructions: doc.instructions,
    modelParams: doc.model_params,
    budgetPolicy: doc.budget_policy,
    brand: doc.brand,
    hash: doc.hash,
    toolBindings: doc.tool_bindings,
    knowledgePins: doc.knowledge_pins,
    modelRef: doc.model_ref,
    templateRef: doc.template_ref,
    manifestHash: doc.manifest_hash,
    createdAt: doc.created_at,
  };
}
