import { customType, index, integer, jsonb, numeric, pgTable, timestamp, uuid, varchar, bigint } from 'drizzle-orm/pg-core';
import { bytea } from '../conversations/mcp.schema';

/**
 * Knowledge plane — Phase 7 (drizzle/0026_knowledge.sql). Engine owns
 * metadata + access state; object storage owns bytes; chunks/embeddings are
 * derived and rebuildable from the source artifact.
 */

/** pgvector column, fixed 1536 dimensions (text-embedding class). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(',')
      .filter((s) => s.length > 0)
      .map(Number);
  },
});

export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_MODEL = 'local-lexical-v1';

export const ARTIFACT_PURPOSES = [
  'SOURCE_DOCUMENT',
  'EXPORT',
  'CHECKPOINT',
  'TOOL_RESULT',
  'TRANSCRIPT',
  'COVER',
  // Harness attachment purposes (drizzle/0035).
  'MESSAGE_ATTACHMENT',
  'GENERATED_MEDIA',
] as const;
export type ArtifactPurpose = (typeof ARTIFACT_PURPOSES)[number];

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    /** Opaque tenant-bound key: org/{orgId}/{purpose}/{uuid} — never user-supplied. */
    objectKey: varchar('object_key', { length: 512 }).notNull(),
    contentTypeDeclared: varchar('content_type_declared', { length: 128 }).notNull(),
    contentTypeDetected: varchar('content_type_detected', { length: 128 }),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    sha256: bytea('sha256').notNull(),
    encryptionKeyRef: varchar('encryption_key_ref', { length: 128 }),
    /** pending | clean | infected | skipped */
    scanStatus: varchar('scan_status', { length: 32 }).notNull().default('pending'),
    /** active | retiring | purged */
    state: varchar('state', { length: 32 }).notNull().default('active'),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('business-history'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_artifacts_org_purpose').on(t.organizationId, t.purpose, t.createdAt)],
);

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    purpose: varchar('purpose', { length: 32 }).notNull(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    mediaType: varchar('media_type', { length: 128 }).notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    /** CREATED → UPLOADING → UPLOADED → SCANNING → EXTRACTING → INDEXING → READY | QUARANTINED | FAILED */
    state: varchar('state', { length: 32 }).notNull().default('CREATED'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    lastError: varchar('last_error', { length: 4096 }),
    /** Processing lease for the ingestion worker (SKIP LOCKED on claim). */
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_upload_sessions_state').on(t.state, t.createdAt)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    sourceArtifactId: uuid('source_artifact_id')
      .notNull()
      .references(() => artifacts.id),
    title: varchar('title', { length: 256 }),
    /** processing | ready | failed */
    state: varchar('state', { length: 32 }).notNull().default('processing'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_documents_org_state').on(t.organizationId, t.state)],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    version: integer('version').notNull(),
    sha256: bytea('sha256').notNull(),
    parserVersion: varchar('parser_version', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_document_versions_doc').on(t.documentId, t.version)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey(),
    documentVersionId: uuid('document_version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    sequence: integer('sequence').notNull(),
    /** { byteStart, byteEnd } into the parsed text — citation anchor. */
    sourceRange: jsonb('source_range').notNull(),
    chunkHash: varchar('chunk_hash', { length: 64 }).notNull(),
    text: varchar('text', { length: 8192 }).notNull(),
  },
  (t) => [index('ix_chunks_version_seq').on(t.documentVersionId, t.sequence)],
);

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey(),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    embedding: vector('embedding').notNull(),
  },
  (t) => [index('ix_embeddings_org').on(t.organizationId)],
);

export const retrievalAcl = pgTable(
  'retrieval_acl',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    resourceType: varchar('resource_type', { length: 32 }).notNull().default('document'),
    resourceId: uuid('resource_id').notNull(),
    /** organization | private (private = scope_account_id only) */
    visibility: varchar('visibility', { length: 32 }).notNull().default('organization'),
    scopeAccountId: uuid('scope_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_retrieval_acl_resource').on(t.organizationId, t.resourceType, t.resourceId)],
);

export const memoryItems = pgTable(
  'memory_items',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    /** organization | conversation | assistant | user */
    scopeType: varchar('scope_type', { length: 32 }).notNull(),
    scopeId: uuid('scope_id'),
    content: varchar('content', { length: 8192 }).notNull(),
    /** { proposal_id } | { message_id } | { document_id } — provenance anchor. */
    sourceRef: jsonb('source_ref'),
    provenance: varchar('provenance', { length: 1024 }),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    visibility: varchar('visibility', { length: 32 }).notNull().default('organization'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_memory_items_scope').on(t.organizationId, t.scopeType, t.scopeId)],
);

export type Artifact = typeof artifacts.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type MemoryItem = typeof memoryItems.$inferSelect;
