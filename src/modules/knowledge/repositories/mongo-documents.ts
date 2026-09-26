/**
 * Shared MongoDB document shapes for the knowledge-module mongo repositories
 * (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Small cross-repo helpers live here too (tenant-scope narrowing,
 * duplicate-key detection) so the knowledge repositories stay focused on
 * their own transaction bodies. Row mappers (BSON → drizzle `$inferSelect`
 * shapes) belong in the per-repository implementation files, next to the
 * queries they serve.
 */
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document } from 'mongodb';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';

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

// ── artifacts ─────────────────────────────────────────────────────────────

export interface ArtifactMongoDoc {
  id: Binary;
  organization_id: Binary;
  purpose: string;
  object_key: string;
  content_type_declared: string;
  content_type_detected: string | null;
  byte_length: number;
  sha256: Binary;
  encryption_key_ref: string | null;
  scan_status: string;
  state: string;
  retention_class: string;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── upload_sessions ───────────────────────────────────────────────────────

export interface UploadSessionMongoDoc {
  id: Binary;
  organization_id: Binary;
  purpose: string;
  artifact_id: Binary;
  media_type: string;
  byte_length: number;
  state: string;
  expires_at: string;
  last_error: string | null;
  locked_at: string | null;
  source_slug: string | null;
  title: string | null;
  target_document_id: Binary | null;
  connector_ref: unknown;
  source_acl: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── documents ─────────────────────────────────────────────────────────────

export interface DocumentMongoDoc {
  id: Binary;
  organization_id: Binary;
  source_artifact_id: Binary;
  title: string | null;
  state: string;
  source_slug: string;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
}

// ── document_versions ─────────────────────────────────────────────────────

export interface DocumentVersionMongoDoc {
  id: Binary;
  document_id: Binary;
  organization_id: Binary;
  version: number;
  sha256: Binary;
  /** Parser/pipeline version — part of the ingestion dedupe and read-back key. */
  parser_version: string;
  created_at: string;
}

// ── chunks ────────────────────────────────────────────────────────────────

export interface ChunkMongoDoc {
  id: Binary;
  document_version_id: Binary;
  organization_id: Binary;
  sequence: number;
  source_range: unknown;
  chunk_hash: string;
  text: string;
}

// ── embeddings ────────────────────────────────────────────────────────────

export interface EmbeddingMongoDoc {
  id: Binary;
  chunk_id: Binary;
  organization_id: Binary;
  model: string;
  /** Stored as a plain array of doubles (pg `vector(1536)` maps to number[]). */
  embedding: number[];
}

// ── retrieval_acl ─────────────────────────────────────────────────────────

export interface RetrievalAclMongoDoc {
  id: Binary;
  organization_id: Binary;
  resource_type: string;
  resource_id: Binary;
  visibility: string;
  scope_account_id: Binary | null;
  created_at: string;
}

// ── memory_items ──────────────────────────────────────────────────────────

export interface MemoryItemMongoDoc {
  id: Binary;
  organization_id: Binary;
  scope_type: string;
  scope_id: Binary | null;
  content: string;
  source_ref: unknown;
  provenance: string | null;
  /** pg numeric arrives as string on the pg lane — stored as string here too. */
  confidence: string | null;
  visibility: string;
  expires_at: string | null;
  deleted_at: string | null;
  embedding: number[] | null;
  embedding_model: string | null;
  valid_from: string;
  invalid_at: string | null;
  supersedes: Binary | null;
  created_at: string;
  updated_at: string;
}

// ── external_principals ────────────────────────────────────────────────────

export interface ExternalPrincipalMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  external_id: string;
  kind: string;
  email: string | null;
  display: string | null;
  created_at: string;
  updated_at: string;
}

// ── external_identity_links ───────────────────────────────────────────────

export interface ExternalIdentityLinkMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  external_id: string;
  account_id: Binary;
  created_at: string;
}

// ── document_source_acls ──────────────────────────────────────────────────

export interface DocumentSourceAclMongoDoc {
  id: Binary;
  organization_id: Binary;
  document_id: Binary;
  provider: string;
  external_id: string;
  created_at: string;
}

// ── connector_accounts ────────────────────────────────────────────────────

export interface ConnectorAccountMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  display_name: string;
  config: unknown;
  credentials_sealed: unknown;
  state: string;
  cursor: unknown;
  last_synced_at: string | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ── connector_oauth_apps ──────────────────────────────────────────────────

export interface ConnectorOAuthAppMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  client_id: string;
  client_secret_sealed: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ── connector_documents ───────────────────────────────────────────────────

export interface ConnectorDocumentMongoDoc {
  id: Binary;
  organization_id: Binary;
  connector_account_id: Binary;
  external_id: string;
  document_id: Binary;
  created_at: string;
}

// ── eval_datasets ─────────────────────────────────────────────────────────

export interface EvalDatasetMongoDoc {
  id: Binary;
  organization_id: Binary;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
}

// ── eval_cases ────────────────────────────────────────────────────────────

export interface EvalCaseMongoDoc {
  id: Binary;
  organization_id: Binary;
  dataset_id: Binary;
  input: unknown;
  expected: unknown;
  rubric: unknown;
  sequence: number;
  created_at: string;
}

// ── eval_runs ─────────────────────────────────────────────────────────────

export interface EvalRunMongoDoc {
  id: Binary;
  organization_id: Binary;
  dataset_id: Binary;
  assistant_version_id: Binary;
  state: string;
  attempts_per_case: number;
  results: unknown;
  /** pg numeric arrives as string on the pg lane — stored as string here too. */
  score: string | null;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  provenance: unknown;
  decision: string | null;
  release_policy_version: number | null;
  is_shadow: boolean;
  policy_snapshot_id: Binary | null;
}

// ── eval_case_executions ──────────────────────────────────────────────────

export interface EvalCaseExecutionMongoDoc {
  id: Binary;
  organization_id: Binary;
  eval_run_id: Binary;
  case_id: Binary;
  attempt: number;
  conversation_id: Binary | null;
  run_id: Binary | null;
  state: string;
  score: string | null;
  response_excerpt: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

// ── analytics_rollups ─────────────────────────────────────────────────────

export interface AnalyticsRollupMongoDoc {
  id: Binary;
  organization_id: Binary;
  kind: string;
  /** yyyy-mm-dd bucket, as an ISO date string. */
  period_start: string;
  scope: unknown;
  metrics: unknown;
  computed_at: string;
}

// ── memory_proposals (cross-module read: owned by conversations, read here
//    by the IMemoryDecisionRepository implementations) ─────────────────────

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

// ── outbox_events (inserted by IEvalRunRepository.createWithOutboxEvent) ──

export interface OutboxEventMongoDoc {
  event_id: Binary;
  aggregate_type: string;
  aggregate_id: Binary;
  organization_id: Binary;
  event_type: string;
  event_version: number;
  payload: unknown;
  partition_key: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  trace_id: string | null;
  correlation_id: Binary | null;
  created_at: string;
  published_at: string | null;
  claimed_at: string | null;
  last_error: string | null;
}
