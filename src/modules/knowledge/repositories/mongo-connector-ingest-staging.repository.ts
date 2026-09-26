/**
 * MongoDB implementation of the connector-ingest-staging repository port
 * (P3) — the atomic artifact + upload-session staging write for connector
 * syncs.
 *
 * Synced content flows through the existing upload-session pipeline: the
 * connector stages an artifact + a session in state UPLOADED, and the
 * ingestion worker picks it up like any other upload. The draft's rows are
 * service-composed (ids, object key, byte length, sha256, connector
 * provenance) — the repository only owns the atomicity: both inserts commit
 * in one TX (an artifact without its session is unclaimable; a session
 * without its artifact violates the FK).
 */
import { Binary } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { ArtifactMongoDoc, UploadSessionMongoDoc } from './mongo-documents';
import type { NewArtifact, NewUploadSession, StagedSourceDocument } from './repository-types';
import type { IConnectorIngestStagingRepository } from './connector-ingest-staging.repository';
import { binUuid, ensureKnowledgeIndexes, nowIso, sessionOf, toIso } from './mongo-knowledge-shared';

const ARTIFACTS = 'artifacts';
const UPLOAD_SESSIONS = 'upload_sessions';

/** Draft → mongo doc, honoring every explicit field; pg defaults as fallback. */
function artifactDoc(orgId: string, a: NewArtifact): ArtifactMongoDoc {
  const now = nowIso();
  return {
    id: binUuid(a.id, 'artifact.id'),
    organization_id: binUuid(orgId, 'orgId'),
    purpose: a.purpose,
    object_key: a.objectKey,
    content_type_declared: a.contentTypeDeclared,
    content_type_detected: a.contentTypeDetected ?? null,
    byte_length: a.byteLength,
    sha256: new Binary(a.sha256, 0),
    encryption_key_ref: a.encryptionKeyRef ?? null,
    scan_status: a.scanStatus ?? 'pending',
    state: a.state ?? 'active',
    retention_class: a.retentionClass ?? 'business-history',
    expires_at: a.expiresAt == null ? null : toIso(a.expiresAt),
    created_by: a.createdBy ?? null,
    created_at: now,
    updated_at: now,
  };
}

/** Draft → mongo doc, honoring every explicit field; pg defaults as fallback. */
function sessionDoc(orgId: string, s: NewUploadSession): UploadSessionMongoDoc {
  const now = nowIso();
  return {
    id: binUuid(s.id, 'session.id'),
    organization_id: binUuid(orgId, 'orgId'),
    purpose: s.purpose,
    artifact_id: binUuid(s.artifactId, 'session.artifactId'),
    media_type: s.mediaType,
    byte_length: s.byteLength,
    state: s.state ?? 'CREATED',
    expires_at: toIso(s.expiresAt),
    last_error: s.lastError ?? null,
    locked_at: s.lockedAt == null ? null : toIso(s.lockedAt),
    source_slug: s.sourceSlug ?? null,
    title: s.title ?? null,
    target_document_id: s.targetDocumentId == null ? null : binUuid(s.targetDocumentId, 'session.targetDocumentId'),
    connector_ref: s.connectorRef ?? null,
    source_acl: s.sourceAcl ?? null,
    created_by: s.createdBy ?? null,
    created_at: now,
    updated_at: now,
  };
}

export class MongoConnectorIngestStagingRepository implements IConnectorIngestStagingRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async stageDocument(orgId: string, draft: StagedSourceDocument): Promise<void> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    // ATOMIC staging, one TX: artifacts.insert + upload_sessions.insert.
    await this.mongo.withOrg(orgId, async (ctx) => {
      const artifacts = new TenantScopedCollection<ArtifactMongoDoc>(db.collection(ARTIFACTS));
      const sessions = new TenantScopedCollection<UploadSessionMongoDoc>(db.collection(UPLOAD_SESSIONS));
      const s = sessionOf(ctx);
      await artifacts.insertOne(orgId, artifactDoc(orgId, draft.artifact), s);
      await sessions.insertOne(orgId, sessionDoc(orgId, draft.session), s);
    });
  }
}
