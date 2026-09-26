/**
 * Shared MongoDB document shapes + row mappers for the lifecycle-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Cross-module subset views (conversations, artifacts, messages,
 * memory_items, run_events, checkpoints, tool_effects, tenants) are declared
 * here as the narrow projections the purge/export steps read — the owning
 * modules' mongo-documents files remain the authority for their full shapes.
 */
import type { Binary, Document } from 'mongodb';
import { requireOrg as baseRequireOrg, tenantCollection as baseTenantCollection } from '../../conversations/repositories/mongo-documents';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { Db } from 'mongodb';
import type { LegalHold, ExportRequest, PurgeTask } from '../lifecycle.schema';

// Re-export the shared helpers so lifecycle repos have one import surface.
export const requireOrg = baseRequireOrg;
export function tenantCollection<T extends Document>(db: Db, name: string) {
  return baseTenantCollection<T>(db, name);
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

function uuidOrNull(value: Binary | null | undefined): string | null {
  return value ? uuidOf(value) : null;
}

// ── legal_holds ───────────────────────────────────────────────────────────

export interface LegalHoldMongoDoc {
  id: Binary;
  organization_id: Binary;
  scope_type: string;
  scope_id: Binary | null;
  hold_reason: string;
  placed_by: string;
  status: string;
  placed_at: string;
  released_at: string | null;
  expires_at: string | null;
}

export function toLegalHold(doc: LegalHoldMongoDoc): LegalHold {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    scopeType: doc.scope_type,
    scopeId: uuidOrNull(doc.scope_id),
    holdReason: doc.hold_reason,
    placedBy: doc.placed_by,
    status: doc.status,
    placedAt: doc.placed_at,
    releasedAt: doc.released_at,
    expiresAt: doc.expires_at,
  };
}

// ── export_requests ───────────────────────────────────────────────────────

export interface ExportRequestMongoDoc {
  id: Binary;
  organization_id: Binary;
  actor_id: string;
  scope: unknown;
  manifest: unknown;
  state: string;
  artifact_id: Binary | null;
  encryption_key_ref: string | null;
  download_token_hash: string | null;
  download_count: number;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
}

export function toExportRequest(doc: ExportRequestMongoDoc): ExportRequest {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    actorId: doc.actor_id,
    scope: doc.scope,
    manifest: doc.manifest,
    state: doc.state,
    artifactId: uuidOrNull(doc.artifact_id),
    encryptionKeyRef: doc.encryption_key_ref,
    downloadTokenHash: doc.download_token_hash,
    downloadCount: doc.download_count,
    expiresAt: doc.expires_at,
    createdAt: doc.created_at,
    completedAt: doc.completed_at,
  };
}

// ── data_access_records (write-only; no row mapper) ───────────────────────

export interface DataAccessRecordMongoDoc {
  id: Binary;
  organization_id: Binary | null;
  actor_type: string;
  actor_id: string;
  access_type: string;
  resource_type: string;
  resource_id: Binary | null;
  justification: string | null;
  trace_id: string | null;
  created_at: string;
}

// ── retention_policies (write-only; no row mapper) ────────────────────────

export interface RetentionPolicyMongoDoc {
  id: Binary;
  organization_id: Binary;
  resource_type: string;
  retention_class: string;
  keep_until_rule: unknown;
  created_by: string | null;
  created_at: string;
}

// ── purge_tasks ───────────────────────────────────────────────────────────

export interface PurgeTaskMongoDoc {
  id: Binary;
  organization_id: Binary;
  scope_type: string;
  scope_id: Binary;
  reason: string;
  state: string;
  step: string;
  last_error: string | null;
  evidence: unknown;
  locked_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export function toPurgeTask(doc: PurgeTaskMongoDoc): PurgeTask {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    scopeType: doc.scope_type,
    scopeId: uuidOf(doc.scope_id),
    reason: doc.reason,
    state: doc.state,
    step: doc.step,
    lastError: doc.last_error,
    evidence: doc.evidence,
    lockedAt: doc.locked_at,
    createdAt: doc.created_at,
    finishedAt: doc.finished_at,
  };
}

// ── tombstones ────────────────────────────────────────────────────────────

export interface TombstoneMongoDoc {
  id: Binary;
  organization_id: Binary | null;
  resource_type: string;
  resource_id: Binary;
  reason: string;
  purged_at: string;
}

// ── cross-module subset views ─────────────────────────────────────────────

/** conversations: the narrow projection the export/purge steps read. */
export interface LifecycleConversationMongoDoc {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary | null;
  channel_binding: unknown;
  participant_scope: string;
  status: string;
  title: string | null;
  version: number;
  branched_from_message_id: Binary | null;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export function toManifestConversation(doc: LifecycleConversationMongoDoc): Record<string, unknown> {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    assistantId: doc.assistant_id ? uuidOf(doc.assistant_id) : null,
    channelBinding: doc.channel_binding ?? {},
    participantScope: doc.participant_scope,
    status: doc.status,
    title: doc.title,
    version: doc.version,
    branchedFromMessageId: uuidOrNull(doc.branched_from_message_id),
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export interface LifecycleMessageRefMongoDoc {
  id: Binary;
  conversation_id: Binary;
  sequence: number;
  role: string;
  content: unknown;
  created_at: string;
}

export interface LifecycleRunRefMongoDoc {
  id: Binary;
  conversation_id: Binary;
  state: string;
  accepted_at: string;
}

export interface LifecycleArtifactMongoDoc {
  id: Binary;
  organization_id: Binary;
  object_key: string;
  state: string;
  retention_class: string;
  created_at: string;
}

export interface LifecycleMemoryItemMongoDoc {
  id: Binary;
  organization_id: Binary;
  scope_type: string;
  scope_id: Binary | null;
}

export interface LifecycleRunEventArtifactMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  artifact_id: Binary | null;
}

export interface LifecycleCheckpointArtifactMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  artifact_id: Binary | null;
}

export interface LifecycleToolEffectArtifactMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  result_artifact_id: Binary | null;
}

export interface LifecycleRunConversationMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
}

/** tenants (python-owned): only the retention window is read. */
export interface LifecycleTenantMongoDoc {
  id: Binary | string;
  retention_days: number | null;
}

export type { MongoTxContext };
