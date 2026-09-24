import { customType, index, integer, jsonb, numeric, pgTable, timestamp, uniqueIndex, uuid, varchar, bigint } from 'drizzle-orm/pg-core';
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
    /**
     * E-2: user-supplied source slug intent (kebab, validated at the API;
     * collision → 409). Carried into documents.source_slug at ingestion.
     * NULL = derive.
     */
    sourceSlug: varchar('source_slug', { length: 64 }),
    /** Display title intent (connector titles; uploads default to the slug). NULL = auto. */
    title: varchar('title', { length: 256 }),
    /**
     * P0-1: re-ingestion target. When set (connector re-sync of a mapped
     * document), ingestion appends a new version onto this document instead
     * of inserting a duplicate. Verified org-scoped at claim time.
     */
    targetDocumentId: uuid('target_document_id'),
    /** P0-1: connector provenance {account_id, external_id} for the doc map. */
    connectorRef: jsonb('connector_ref'),
    /** P0-1: source ACL intent {mode, principals[]} applied at READY. */
    sourceAcl: jsonb('source_acl'),
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
    /** processing | ready | failed | retired (source-deleted tombstone; unreachable by retrieval) */
    state: varchar('state', { length: 32 }).notNull().default('processing'),
    /**
     * E-2: immutable pin address (kebab, unique per org). Set from the
     * upload intent or derived at ingestion; renamable only through the
     * explicit rename endpoint (old pins then resolve visibly unresolved).
     * Display stays in `title` — slugs are addresses, not names.
     */
    sourceSlug: varchar('source_slug', { length: 64 }).notNull(),
    /** FL-2.2: embedding model the document's active vectors were computed with. */
    embeddingModel: varchar('embedding_model', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_documents_org_state').on(t.organizationId, t.state),
    uniqueIndex('uq_documents_org_slug').on(t.organizationId, t.sourceSlug),
  ],
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
  (t) => [uniqueIndex('uq_document_versions_doc_version').on(t.documentId, t.version)],
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
  (t) => [
    index('ix_chunks_version_seq').on(t.documentVersionId, t.sequence),
    index('ix_chunks_org_version').on(t.organizationId, t.documentVersionId),
  ],
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
    /** FL-2.4: approval-time embedding - semantic memory search (HNSW cosine). */
    embedding: vector('embedding'),
    /**
     * P0 (ai-native-review.md BUG-1): the model that produced `embedding`.
     * The memory leg scopes to it (NULL = legacy row, still participates).
     * Stamped at write time — the only honest provenance for the vector.
     */
    embeddingModel: varchar('embedding_model', { length: 64 }),
    /** FL-3.9: temporal validity - supersedes marks the replaced prior item. */
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    invalidAt: timestamp('invalid_at', { withTimezone: true, mode: 'string' }),
    supersedes: uuid('supersedes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_memory_items_scope').on(t.organizationId, t.scopeType, t.scopeId)],
);

export type Artifact = typeof artifacts.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;

/**
 * P0-1 — external principals: users/groups/domains known to an external
 * source (Drive permission id, Graph identity, Confluence account). Matching
 * to Engine callers happens by verified email first, then by explicit link.
 */
export const externalPrincipals = pgTable(
  'external_principals',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    externalId: varchar('external_id', { length: 512 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    email: varchar('email', { length: 320 }),
    display: varchar('display', { length: 256 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_external_principals_org_provider_external').on(t.organizationId, t.provider, t.externalId),
    index('ix_external_principals_org_email').on(t.organizationId, t.email),
  ],
);

/** Explicit external-id → account links (auto-created on email equality at sync). */
export const externalIdentityLinks = pgTable(
  'external_identity_links',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    externalId: varchar('external_id', { length: 512 }).notNull(),
    accountId: uuid('account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_external_identity_links').on(t.organizationId, t.provider, t.externalId),
    index('ix_external_identity_links_account').on(t.organizationId, t.accountId),
  ],
);

/**
 * P0-1 — per-document source allow-lists. A document WITH rows here is
 * restricted: retrieval admits it only for callers matching a listed
 * principal (linked account or verified email). No rows = legacy posture
 * (org visibility via retrieval_acl). Unknown principals default-deny.
 */
export const documentSourceAcls = pgTable(
  'document_source_acls',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    externalId: varchar('external_id', { length: 512 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_document_source_acls').on(t.documentId, t.provider, t.externalId),
    index('ix_document_source_acls_org_doc').on(t.organizationId, t.documentId),
  ],
);

export type ExternalPrincipal = typeof externalPrincipals.$inferSelect;
export type DocumentSourceAcl = typeof documentSourceAcls.$inferSelect;
export type MemoryItem = typeof memoryItems.$inferSelect;
