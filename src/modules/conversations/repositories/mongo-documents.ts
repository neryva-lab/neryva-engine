/**
 * Shared MongoDB document shapes + row mappers for the conversations-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Small cross-repo helpers live here too (tenant-scope narrowing,
 * duplicate-key detection, lease fencing) so the five repositories stay
 * focused on their own transaction bodies.
 */
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document, WithId } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { Escalation } from '../escalations.schema';
import type { Run, RunEvent } from '../schema';

/** Fail closed when a withOrg callback somehow carries no tenant scope. */
export function requireOrg(ctx: MongoTxContext): string {
  const orgId = ctx.orgId;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error('mongo repository: refusing unscoped access — withOrg guarantees a tenant scope');
  }
  return orgId;
}

/** Tenant-guarded handle for a collection (plan D6 — explicit org predicate). */
export function tenantCollection<T extends Document>(
  db: Db,
  name: string,
): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name));
}

/** True for MongoDB duplicate-key errors (plan D7: the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

/**
 * Lease-epoch fencing (mcp-authority.service.ts `assertLeaseFencing`,
 * ledger 5.11). A token that CARRIES a lease_epoch claim must present the
 * run's CURRENT epoch.
 */
export function assertLeaseFencing(run: Run, claimsLeaseEpoch?: number): void {
  if (claimsLeaseEpoch !== undefined && claimsLeaseEpoch !== run.leaseEpoch) {
    throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
      token_epoch: claimsLeaseEpoch,
      run_epoch: run.leaseEpoch,
    });
  }
}

// ── escalations ───────────────────────────────────────────────────────────

export interface EscalationMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  run_id: Binary | null;
  reason: string;
  state: 'WAITING' | 'CLAIMED' | 'RESOLVED';
  claimed_by: string | null;
  requested_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  sla_expires_at: string | null;
  resolution_note: string | null;
  brief: unknown;
  created_at: string;
  updated_at: string;
}

export function toEscalation(doc: WithId<EscalationMongoDoc>): Escalation {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    conversationId: uuidOf(doc.conversation_id),
    runId: doc.run_id ? uuidOf(doc.run_id) : null,
    reason: doc.reason,
    state: doc.state,
    claimedBy: doc.claimed_by,
    requestedAt: doc.requested_at,
    claimedAt: doc.claimed_at,
    resolvedAt: doc.resolved_at,
    slaExpiresAt: doc.sla_expires_at,
    resolutionNote: doc.resolution_note,
    brief: doc.brief,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── conversations (subset read/written by the escalation paths) ───────────

export interface ConversationMongoDoc {
  id: Binary;
  organization_id: Binary;
  status: string;
  version: number;
  updated_at: string;
}

// ── messages (subset read/written by the escalation paths) ────────────────

export interface MessageMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  sequence: number;
  role: string;
  content: unknown;
  created_by: string | null;
  created_at: string;
}

// ── conversation_summaries (brief composition read) ───────────────────────

export interface ConversationSummaryMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  source_sequence: number;
  summary: string;
}

// ── runs ──────────────────────────────────────────────────────────────────

export interface RunMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  input_message_id: Binary;
  assistant_version_id: Binary;
  policy_snapshot_id: Binary;
  state: string;
  run_kind: string;
  version: number;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  accepted_at: string;
  started_at: string | null;
  finished_at: string | null;
  terminal_reason: string | null;
  result_message_id: Binary | null;
  regenerated_message_id: Binary | null;
  last_event_sequence: number;
  created_at: string;
  updated_at: string;
}

export function toRun(doc: WithId<RunMongoDoc>): Run {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    conversationId: uuidOf(doc.conversation_id),
    inputMessageId: uuidOf(doc.input_message_id),
    assistantVersionId: uuidOf(doc.assistant_version_id),
    policySnapshotId: uuidOf(doc.policy_snapshot_id),
    state: doc.state,
    runKind: doc.run_kind,
    version: doc.version,
    leaseOwner: doc.lease_owner,
    leaseEpoch: doc.lease_epoch,
    leaseExpiresAt: doc.lease_expires_at,
    heartbeatAt: doc.heartbeat_at,
    acceptedAt: doc.accepted_at,
    startedAt: doc.started_at,
    finishedAt: doc.finished_at,
    terminalReason: doc.terminal_reason,
    resultMessageId: doc.result_message_id ? uuidOf(doc.result_message_id) : null,
    regeneratedMessageId: doc.regenerated_message_id ? uuidOf(doc.regenerated_message_id) : null,
    lastEventSequence: doc.last_event_sequence,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── run_events ────────────────────────────────────────────────────────────

export interface RunEventMongoDoc {
  id: Binary;
  run_id: Binary;
  organization_id: Binary;
  event_id: string;
  event_type: string;
  schema_version: number;
  engine_sequence: number;
  causation_id: Binary | null;
  correlation_id: Binary | null;
  producer_identity: string | null;
  producer_sequence: number | null;
  payload: unknown;
  artifact_id: Binary | null;
  created_at: string;
}

export function toRunEvent(doc: WithId<RunEventMongoDoc>): RunEvent {
  return {
    id: uuidOf(doc.id),
    runId: uuidOf(doc.run_id),
    organizationId: uuidOf(doc.organization_id),
    eventId: doc.event_id,
    eventType: doc.event_type,
    schemaVersion: doc.schema_version,
    engineSequence: doc.engine_sequence,
    causationId: doc.causation_id ? uuidOf(doc.causation_id) : null,
    correlationId: doc.correlation_id ? uuidOf(doc.correlation_id) : null,
    producerIdentity: doc.producer_identity,
    producerSequence: doc.producer_sequence,
    payload: doc.payload,
    artifactId: doc.artifact_id ? uuidOf(doc.artifact_id) : null,
    createdAt: doc.created_at,
  };
}

// ── run_idempotency ────────────────────────────────────────────────────────

export interface RunIdempotencyMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  caller_scope: string;
  idempotency_key: string;
  request_hash: string;
  status: string;
  resource_ref: unknown;
  created_at: string;
  expires_at: string;
}

// ── memory_proposals ──────────────────────────────────────────────────────

export interface MemoryProposalMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  proposal_ref: string;
  scope: string;
  value: string;
  provenance: string | null;
  /** pg numeric arrives as string on the pg lane — stored as string here too. */
  confidence: string | null;
  visibility: string | null;
  expires_at: string | null;
  decision: string;
  created_at: string;
}

// ── quota_reservations (subset written by the failRun path) ────────────────

export interface QuotaReservationMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary | null;
  state: string;
  released_at: string | null;
}
