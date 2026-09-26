/**
 * MongoDB implementation of the upload-session repository port (P3) — the
 * persistence port for the upload lifecycle (`ArtifactsService` + the
 * ingestion worker).
 *
 * Mixed tenancy, exactly per the interface contract:
 * - Worker methods (`claimNext`, `releaseLock`, `applyScanVerdict`,
 *   `markExtracting`, `markFailed`, `markReady`, `getArtifactForExtraction`)
 *   run BYPASS (`mongo.withBypass`) — the ingestion worker has no request
 *   tenant context and re-verifies the session's `organizationId` before
 *   acting on it. They use the raw collections (no tenant predicate).
 * - API methods (`createWithArtifact`, `getSessionWithArtifact`,
 *   `claimUploaded`) run withOrg under the caller's `orgId` with an
 *   explicit `organization_id` predicate on every access.
 *
 * `claimNext` is a single atomic `findOneAndUpdate` (oldest `created_at`
 * first, free-or-stale lock) — the single-document atomicity replaces the
 * pg lane's `SELECT … FOR UPDATE SKIP LOCKED` + lease stamp.
 */
import { Binary } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { Artifact, UploadSession } from '../schema';
import type { ArtifactMongoDoc, DocumentMongoDoc, UploadSessionMongoDoc } from './mongo-documents';
import type { NewArtifact, NewUploadSession } from './repository-types';
import type { IUploadSessionRepository } from './upload-session.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  sessionOf,
  toArtifactRow,
  toIso,
  toUploadSessionRow,
  txCollection,
} from './mongo-knowledge-shared';

const ARTIFACTS = 'artifacts';
const SESSIONS = 'upload_sessions';
const DOCUMENTS = 'documents';

/** NewArtifact (camelCase $inferInsert) → the artifact mongo document. */
function artifactDocFromNew(orgId: string, input: NewArtifact, now: string): ArtifactMongoDoc {
  return {
    id: binUuid(input.id, 'artifact.id'),
    organization_id: binUuid(orgId, 'orgId'),
    purpose: input.purpose,
    object_key: input.objectKey,
    content_type_declared: input.contentTypeDeclared,
    content_type_detected: input.contentTypeDetected ?? null,
    byte_length: input.byteLength,
    sha256: new Binary(input.sha256, 0),
    encryption_key_ref: input.encryptionKeyRef ?? null,
    scan_status: input.scanStatus ?? 'pending',
    state: input.state ?? 'active',
    retention_class: input.retentionClass ?? 'business-history',
    expires_at: input.expiresAt == null ? null : toIso(input.expiresAt),
    created_by: input.createdBy ?? null,
    created_at: input.createdAt == null ? now : toIso(input.createdAt),
    updated_at: input.updatedAt == null ? now : toIso(input.updatedAt),
  };
}

/** NewUploadSession (camelCase $inferInsert) → the session mongo document. */
function sessionDocFromNew(orgId: string, input: NewUploadSession, now: string): UploadSessionMongoDoc {
  return {
    id: binUuid(input.id, 'session.id'),
    organization_id: binUuid(orgId, 'orgId'),
    purpose: input.purpose,
    artifact_id: binUuid(input.artifactId, 'session.artifactId'),
    media_type: input.mediaType,
    byte_length: input.byteLength,
    state: input.state ?? 'CREATED',
    expires_at: toIso(input.expiresAt),
    last_error: input.lastError ?? null,
    locked_at: input.lockedAt == null ? null : toIso(input.lockedAt),
    source_slug: input.sourceSlug ?? null,
    title: input.title ?? null,
    target_document_id:
      input.targetDocumentId == null ? null : binUuid(input.targetDocumentId, 'session.targetDocumentId'),
    connector_ref: input.connectorRef ?? null,
    source_acl: input.sourceAcl ?? null,
    created_by: input.createdBy ?? null,
    created_at: input.createdAt == null ? now : toIso(input.createdAt),
    updated_at: input.updatedAt == null ? now : toIso(input.updatedAt),
  };
}

export class MongoUploadSessionRepository implements IUploadSessionRepository {
  constructor(private readonly mongo: MongoDbService) {}

  // ── worker methods (BYPASS) ─────────────────────────────────────────────

  async claimNext(states: string[], staleBefore: Date): Promise<UploadSession | null> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withBypass(async (ctx) => {
      const s = sessionOf(ctx);
      const doc = await db.collection<UploadSessionMongoDoc>(SESSIONS).findOneAndUpdate(
        {
          state: { $in: states },
          $or: [{ locked_at: null }, { locked_at: { $lt: toIso(staleBefore) } }],
        },
        { $set: { locked_at: toIso(new Date()) } },
        { ...s, sort: { created_at: 1 }, returnDocument: 'after' },
      );
      return doc ? toUploadSessionRow(doc) : null;
    });
  }

  async releaseLock(sessionId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      await db
        .collection<UploadSessionMongoDoc>(SESSIONS)
        .updateOne(
          { id: binUuid(sessionId, 'sessionId') },
          { $set: { locked_at: null } },
          sessionOf(ctx),
        );
    });
  }

  async applyScanVerdict(input: {
    sessionId: string;
    artifactId: string;
    verdict: 'clean' | 'infected' | 'skipped';
    at: Date;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const s = sessionOf(ctx);
      const at = toIso(input.at);
      const sessionId = binUuid(input.sessionId, 'sessionId');
      const artifactId = binUuid(input.artifactId, 'artifactId');
      if (input.verdict === 'infected') {
        await db
          .collection<UploadSessionMongoDoc>(SESSIONS)
          .updateOne({ id: sessionId }, { $set: { state: 'QUARANTINED', updated_at: at } }, s);
        await db
          .collection<ArtifactMongoDoc>(ARTIFACTS)
          .updateOne({ id: artifactId }, { $set: { scan_status: 'infected', updated_at: at } }, s);
        return;
      }
      await db
        .collection<UploadSessionMongoDoc>(SESSIONS)
        .updateOne({ id: sessionId }, { $set: { state: 'SCANNING', updated_at: at } }, s);
      await db
        .collection<ArtifactMongoDoc>(ARTIFACTS)
        .updateOne(
          { id: artifactId },
          { $set: { scan_status: input.verdict, updated_at: at } },
          s,
        );
    });
  }

  async markExtracting(sessionId: string, at: Date): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      await db
        .collection<UploadSessionMongoDoc>(SESSIONS)
        .updateOne(
          { id: binUuid(sessionId, 'sessionId') },
          { $set: { state: 'EXTRACTING', last_error: null, updated_at: toIso(at) } },
          sessionOf(ctx),
        );
    });
  }

  async markFailed(input: {
    sessionId: string;
    artifactId: string;
    error: string;
    at: Date;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const s = sessionOf(ctx);
      const at = toIso(input.at);
      const artifactId = binUuid(input.artifactId, 'artifactId');
      await db
        .collection<UploadSessionMongoDoc>(SESSIONS)
        .updateOne(
          { id: binUuid(input.sessionId, 'sessionId') },
          {
            $set: {
              state: 'FAILED',
              last_error: input.error.slice(0, 4000),
              updated_at: at,
            },
          },
          s,
        );
      // Keyed on the artifact id, NOT on the session's document: a
      // re-ingested session has no single document row to match against,
      // and matching by session would leave orphaned `processing` documents
      // behind. Deliberately misses version sessions (their artifact is
      // new) — a failed version ingestion must NOT touch the document row.
      await db
        .collection<DocumentMongoDoc>(DOCUMENTS)
        .updateMany(
          { source_artifact_id: artifactId },
          { $set: { state: 'failed', updated_at: at } },
          s,
        );
    });
  }

  async markReady(sessionId: string, at: Date): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      await db
        .collection<UploadSessionMongoDoc>(SESSIONS)
        .updateOne(
          { id: binUuid(sessionId, 'sessionId') },
          { $set: { state: 'READY', updated_at: toIso(at) } },
          sessionOf(ctx),
        );
    });
  }

  async getArtifactForExtraction(artifactId: string): Promise<{
    objectKey: string;
    contentTypeDetected: string | null;
    contentTypeDeclared: string;
  } | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const doc = await db
        .collection<ArtifactMongoDoc>(ARTIFACTS)
        .findOne({ id: binUuid(artifactId, 'artifactId') }, sessionOf(ctx));
      if (!doc) return null;
      return {
        objectKey: doc.object_key,
        contentTypeDetected: doc.content_type_detected,
        contentTypeDeclared: doc.content_type_declared,
      };
    });
  }

  // ── API methods (withOrg) ───────────────────────────────────────────────

  async createWithArtifact(
    orgId: string,
    artifact: NewArtifact,
    session: NewUploadSession,
  ): Promise<{ artifact: Artifact; session: UploadSession }> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const artifacts = txCollection<ArtifactMongoDoc>(db, ARTIFACTS);
      const sessions = txCollection<UploadSessionMongoDoc>(db, SESSIONS);
      const s = sessionOf(ctx);
      const now = toIso(new Date());
      const artifactDoc = artifactDocFromNew(orgId, artifact, now);
      const sessionDoc = sessionDocFromNew(orgId, session, now);
      // The session FK references the artifact — the pair commits together;
      // a session without its artifact is unclaimable.
      await artifacts.insertOne(orgId, artifactDoc, s);
      await sessions.insertOne(orgId, sessionDoc, s);
      return { artifact: toArtifactRow(artifactDoc), session: toUploadSessionRow(sessionDoc) };
    });
  }

  async getSessionWithArtifact(
    orgId: string,
    sessionId: string,
  ): Promise<{ session: UploadSession; artifact: Artifact } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const sessions = txCollection<UploadSessionMongoDoc>(db, SESSIONS);
      const artifacts = txCollection<ArtifactMongoDoc>(db, ARTIFACTS);
      const s = sessionOf(ctx);
      const sessionDoc = await sessions.findOne(
        orgId,
        { id: binUuid(sessionId, 'sessionId') },
        s,
      );
      if (!sessionDoc) return null;
      const artifactDoc = await artifacts.findOne(orgId, { id: sessionDoc.artifact_id }, s);
      if (!artifactDoc) return null;
      return { session: toUploadSessionRow(sessionDoc), artifact: toArtifactRow(artifactDoc) };
    });
  }

  async claimUploaded(
    orgId: string,
    sessionId: string,
    detectedContentType: string,
  ): Promise<UploadSession | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const sessions = txCollection<UploadSessionMongoDoc>(db, SESSIONS);
      const artifacts = txCollection<ArtifactMongoDoc>(db, ARTIFACTS);
      const s = sessionOf(ctx);
      // Compare-and-set: only a session still in CREATED transitions. A
      // non-CREATED session reads as a duplicate/redelivery, not an error.
      const sessionDoc = await sessions.findOneAndUpdate(
        orgId,
        { id: binUuid(sessionId, 'sessionId'), state: 'CREATED' },
        { $set: { state: 'UPLOADED', updated_at: toIso(new Date()) } },
        { ...s, returnDocument: 'after' },
      );
      if (!sessionDoc) return null;
      await artifacts.updateOne(
        orgId,
        { id: sessionDoc.artifact_id },
        { $set: { content_type_detected: detectedContentType, updated_at: toIso(new Date()) } },
        s,
      );
      return toUploadSessionRow(sessionDoc);
    });
  }
}
