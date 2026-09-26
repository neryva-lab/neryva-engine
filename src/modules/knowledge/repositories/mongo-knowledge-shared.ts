/**
 * Shared row-mapping and coercion helpers for the knowledge-module mongo
 * repositories (P3).
 *
 * BSON conventions (plan D4): UUIDs are Binary subtype 4, field names are the
 * pg snake_case column names, timestamps are ISO-8601 strings. Services pass
 * `Date` where the pg lane accepts one; this module normalizes them to ISO
 * strings on the way in.
 */
import { Binary } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { binUuid } from '../../conversations/repositories/mongo-conversation.repository';
import type {
  ArtifactMongoDoc,
  DocumentMongoDoc,
  UploadSessionMongoDoc,
} from './mongo-documents';
import type { Artifact, DocumentRow, UploadSession } from './repository-types';

/** The conversation slice owns UUID parsing — reuse it, don't duplicate it. */
export { binUuid };

/** Normalize a pg-lane timestamp (ISO string or Date) to an ISO-8601 string. */
export function toIso(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw ApiError.validation({ timestamp: 'must be a valid date' });
    }
    return value.toISOString();
  }
  return value;
}

/** Current UTC time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Mint a time-sortable uuidv7 row id. */
export function newId(): string {
  return uuidv7();
}

/** Binary → UUID string for an optional uuid column. */
export function uuidOrNull(value: Binary | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toUUID().toString();
}

/** Binary → UUID string for a required uuid column. */
export function uuidOf(value: Binary | null | undefined): string {
  const parsed = uuidOrNull(value);
  if (parsed === null) {
    throw new Error('mongo repository: expected uuid binary, got null');
  }
  return parsed;
}

/** The `{ session }` options object every tx-scoped driver call must carry. */
export function sessionOf(ctx: MongoTxContext): { session: MongoTxContext['session'] } {
  return { session: ctx.session };
}

/** Tenant-guarded handle for a collection inside a transaction body. */
export function txCollection<T extends Document>(
  db: Db,
  name: string,
): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name));
}

// ── unique-index ensurement (plan D7) ───────────────────────────────────────

/**
 * Create the unique indexes the knowledge writes rely on, once per `Db`
 * handle. These mirror the PostgreSQL unique constraints the pg lane depends
 * on for its `onConflictDoNothing` / `onConflictDoUpdate` / upsert-key
 * semantics. The migration registry owns the canonical index set; the
 * repositories ensure the missing ones defensively here. Idempotent —
 * `createIndex` with the same name and spec is a no-op.
 */
/**
 * Create the unique indexes the knowledge writes rely on, once per `Db`
 * handle. These mirror the PostgreSQL unique constraints the pg lane depends
 * on for its `onConflictDoNothing` / `onConflictDoUpdate` / upsert-key
 * semantics. Names and key specs match the drizzle SQL migrations exactly
 * (`0026_knowledge.sql`, `0039_connectors.sql`, `0040_parity_tables.sql`,
 * `0057_enterprise_knowledge_p0.sql`, `0072_document_versions_doc_version_unique.sql`).
 *
 * Several of these are NOT in the mongo migration registry
 * (`0001_engine_core.ts` lacks `uq_documents_source_artifact`,
 * `uq_document_versions`, `uq_chunks_version_sequence`,
 * `uq_embeddings_chunk`, `uq_retrieval_acl`, `uq_document_source_acls`,
 * `uq_external_principals_org_provider_external`,
 * `uq_external_identity_links`, `uq_connector_documents_account_external`,
 * `uq_connector_oauth_apps_org_provider`, and `uq_eval_datasets_org_name`
 * as of 2026-09-26) — the ensurement here is load-bearing, not redundant.
 * Idempotent: `createIndex` with the same name and spec is a no-op, so
 * indexes the registry already defines converge silently. The `chunks`
 * text index ships in the registry as `ix_chunks_fts` (mongo allows only
 * one text index per collection) and is deliberately NOT re-ensured here;
 * it is the mongo counterpart of the pg `fts` tsvector column for the
 * retrieval FTS leg.
 */
const ensuredDatabases = new WeakSet<Db>();

export async function ensureKnowledgeIndexes(db: Db): Promise<void> {
  if (ensuredDatabases.has(db)) return;
  const unique = (name: string) => ({ unique: true, name });
  await db.collection('documents').createIndex({ source_artifact_id: 1 }, unique('uq_documents_source_artifact'));
  await db.collection('documents').createIndex(
    { organization_id: 1, source_slug: 1 },
    unique('uq_documents_org_slug'),
  );
  await db.collection('document_versions').createIndex(
    { document_id: 1, sha256: 1, parser_version: 1 },
    unique('uq_document_versions'),
  );
  await db.collection('document_versions').createIndex(
    { document_id: 1, version: 1 },
    unique('uq_document_versions_doc_version'),
  );
  await db.collection('chunks').createIndex(
    { document_version_id: 1, sequence: 1 },
    unique('uq_chunks_version_sequence'),
  );
  // Lexical leg: the mongo counterpart of the pg `fts` tsvector column
  // (`websearch_to_tsquery('english', ...)` — english stemming/stop-words,
  // phrase + negation operators). The text index itself ships in the mongo
  // migration registry (`ix_chunks_fts`); mongo allows only one text index
  // per collection, so it is NOT re-ensured here.
  await db.collection('document_source_acls').createIndex(
    { document_id: 1, provider: 1, external_id: 1 },
    unique('uq_document_source_acls'),
  );
  await db.collection('embeddings').createIndex({ chunk_id: 1, model: 1 }, unique('uq_embeddings_chunk'));
  await db.collection('connector_accounts').createIndex(
    { organization_id: 1, provider: 1, display_name: 1 },
    unique('uq_connector_accounts_org_provider_name'),
  );
  await db.collection('connector_documents').createIndex(
    { organization_id: 1, connector_account_id: 1, external_id: 1 },
    unique('uq_connector_documents_account_external'),
  );
  await db.collection('connector_oauth_apps').createIndex(
    { organization_id: 1, provider: 1 },
    unique('uq_connector_oauth_apps_org_provider'),
  );
  await db.collection('eval_datasets').createIndex(
    { organization_id: 1, name: 1 },
    unique('uq_eval_datasets_org_name'),
  );
  await db.collection('external_identity_links').createIndex(
    { organization_id: 1, provider: 1, external_id: 1 },
    unique('uq_external_identity_links'),
  );
  await db.collection('external_principals').createIndex(
    { organization_id: 1, provider: 1, external_id: 1 },
    unique('uq_external_principals_org_provider_external'),
  );
  // Retrieval ACL lookup key: named for the legacy `uq_retrieval_acl`
  // constraint, but deliberately NON-unique — several rows per document are
  // permitted (the grant port's contract is plain INSERT: repeated grants
  // accumulate).
  await db.collection('retrieval_acl').createIndex(
    { resource_type: 1, resource_id: 1, visibility: 1, scope_account_id: 1 },
    { name: 'uq_retrieval_acl' },
  );
  ensuredDatabases.add(db);
}

// ── artifact row mappers ──────────────────────────────────────────────────

export function toArtifactRow(doc: ArtifactMongoDoc): Artifact {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    purpose: doc.purpose,
    objectKey: doc.object_key,
    contentTypeDeclared: doc.content_type_declared,
    contentTypeDetected: doc.content_type_detected,
    byteLength: doc.byte_length,
    sha256: Buffer.from(doc.sha256.buffer),
    encryptionKeyRef: doc.encryption_key_ref,
    scanStatus: doc.scan_status,
    state: doc.state,
    retentionClass: doc.retention_class,
    expiresAt: doc.expires_at,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/** Build the artifact document the service's NewArtifact insert carries. */
export function artifactDoc(
  orgId: string,
  input: {
    id: string;
    purpose: string;
    objectKey: string;
    contentTypeDeclared: string;
    contentTypeDetected?: string | null;
    byteLength: number;
    sha256: Buffer;
    encryptionKeyRef?: string | null;
    retentionClass?: string;
    expiresAt?: string | Date | null;
    createdBy?: string | null;
  },
): ArtifactMongoDoc {
  const now = nowIso();
  return {
    id: binUuid(input.id),
    organization_id: binUuid(orgId, 'orgId'),
    purpose: input.purpose,
    object_key: input.objectKey,
    content_type_declared: input.contentTypeDeclared,
    content_type_detected: input.contentTypeDetected ?? null,
    byte_length: input.byteLength,
    sha256: new Binary(input.sha256, 0),
    encryption_key_ref: input.encryptionKeyRef ?? null,
    scan_status: 'pending',
    state: 'active',
    retention_class: input.retentionClass ?? 'business-history',
    expires_at: input.expiresAt == null ? null : toIso(input.expiresAt),
    created_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now,
  };
}

// ── upload session row mappers ────────────────────────────────────────────

export function toUploadSessionRow(doc: UploadSessionMongoDoc): UploadSession {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    purpose: doc.purpose,
    artifactId: uuidOf(doc.artifact_id),
    mediaType: doc.media_type,
    byteLength: doc.byte_length,
    state: doc.state,
    expiresAt: doc.expires_at,
    lastError: doc.last_error,
    lockedAt: doc.locked_at,
    sourceSlug: doc.source_slug,
    title: doc.title,
    targetDocumentId: uuidOrNull(doc.target_document_id),
    connectorRef: doc.connector_ref as UploadSession['connectorRef'],
    sourceAcl: doc.source_acl as UploadSession['sourceAcl'],
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── document row mappers ──────────────────────────────────────────────────

export function toDocumentRow(doc: DocumentMongoDoc): DocumentRow {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    sourceArtifactId: uuidOf(doc.source_artifact_id),
    title: doc.title,
    state: doc.state,
    sourceSlug: doc.source_slug,
    embeddingModel: doc.embedding_model,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/** Cosine distance (pgvector `<=>`) between two same-length vectors. */
export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
