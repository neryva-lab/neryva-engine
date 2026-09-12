import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { env } from '../../common/config/env';
import { artifacts, uploadSessions, Artifact, UploadSession } from './schema';
import { ARTIFACT_PURPOSES } from './schema';

/**
 * Artifacts — the claim-check facade (Phase 7, ledger 7.1/7.2/7.9 + MCP 5.12).
 *
 * Engine owns metadata + access state; object storage owns bytes. Object
 * keys are tenant-bound `org/{orgId}/{purpose}/{uuid}` — never user-supplied.
 * Dereferencing an artifact is a FRESH authorization pass (the 7 checks);
 * an ArtifactRef is a capability, not a bearer URL.
 */
const MEDIA_TYPE_ALLOWLIST = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Harness attachment media (chat images / PDFs).
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
];
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

@Injectable()
export class ArtifactsService {
  private static readonly logger = new Logger(ArtifactsService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Upload sessions (7.2) ───────────────────────────────────────────────

  /** Authorize → create session+artifact → presign a tenant-bound upload. */
  async createUploadSession(input: {
    orgId: string;
    purpose: string;
    mediaType: string;
    byteLength: number;
    sha256Hex: string;
    createdBy: string;
  }): Promise<{ session: UploadSession; upload: { url: string; fields: Record<string, string>; expiresIn: number } }> {
    assertUuid(input.orgId, 'orgId');
    if (!(ARTIFACT_PURPOSES as readonly string[]).includes(input.purpose)) {
      throw ApiError.validation({ purpose: `must be one of ${ARTIFACT_PURPOSES.join(', ')}` });
    }
    if (!MEDIA_TYPE_ALLOWLIST.includes(input.mediaType)) {
      throw ApiError.validation({ media_type: `must be one of ${MEDIA_TYPE_ALLOWLIST.join(', ')}` });
    }
    if (!Number.isInteger(input.byteLength) || input.byteLength <= 0) {
      throw ApiError.validation({ byte_length: 'must be a positive integer' });
    }
    if (input.byteLength > env.KNOWLEDGE_MAX_UPLOAD_BYTES) {
      throw ApiError.validation({ byte_length: `exceeds KNOWLEDGE_MAX_UPLOAD_BYTES (${env.KNOWLEDGE_MAX_UPLOAD_BYTES})` });
    }
    if (!/^[0-9a-f]{64}$/i.test(input.sha256Hex)) {
      throw ApiError.validation({ sha256: 'must be 64 hex chars' });
    }
    this.storage.requireAvailable();

    const artifactId = uuidv7();
    const sessionId = uuidv7();
    // Tenant-bound, random, purpose-scoped — the client never names the key.
    const objectKey = `org/${input.orgId}/${input.purpose.toLowerCase()}/${artifactId}.${CONTENT_TYPE_EXTENSIONS[input.mediaType] ?? 'bin'}`;
    this.storage.assertTenantKey(objectKey, input.orgId);

    const upload = this.storage.presignUpload({
      key: objectKey,
      contentType: input.mediaType,
      // Exact size window — the object must match the declared byte length.
      sizeRange: { min: input.byteLength, max: input.byteLength },
      expiresIn: 600,
      metadata: { sha256: input.sha256Hex.toLowerCase(), artifact_id: artifactId },
    });

    const result = await this.db.withOrg(input.orgId, async (tx) => {
      const artifactRows = await tx
        .insert(artifacts)
        .values({
          id: artifactId,
          organizationId: input.orgId,
          purpose: input.purpose,
          objectKey,
          contentTypeDeclared: input.mediaType,
          byteLength: input.byteLength,
          sha256: Buffer.from(input.sha256Hex, 'hex'),
          createdBy: input.createdBy,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), // unfinished uploads age out
        })
        .returning();
      const sessionRows = await tx
        .insert(uploadSessions)
        .values({
          id: sessionId,
          organizationId: input.orgId,
          purpose: input.purpose,
          artifactId: artifactRows[0].id,
          mediaType: input.mediaType,
          byteLength: input.byteLength,
          state: 'CREATED',
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          createdBy: input.createdBy,
        })
        .returning();
      return { session: sessionRows[0], artifact: artifactRows[0] };
    });

    await this.audit.add({
      action: 'artifact.upload_authorized',
      resourceType: 'artifact',
      resourceId: artifactId,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { purpose: input.purpose, media_type: input.mediaType, byte_length: input.byteLength },
    });
    return { session: result.session, upload };
  }

  /**
   * Client claims the upload complete: verify the object exists with the
   * exact byte length and bound sha256 metadata, then release it to the
   * ingestion pipeline (state UPLOADED).
   */
  async completeUploadSession(input: { orgId: string; sessionId: string; actor: string }): Promise<UploadSession> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.sessionId, 'sessionId');
    this.storage.requireAvailable();
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, input.sessionId)).limit(1);
      if (rows.length === 0) {
        throw ApiError.notFound('upload session');
      }
      const session = rows[0];
      if (session.state !== 'CREATED') {
        throw ApiError.conflict('upload session is not awaiting completion', { state: session.state });
      }
      const artifactRows = await tx.select().from(artifacts).where(eq(artifacts.id, session.artifactId)).limit(1);
      if (artifactRows.length === 0) {
        throw ApiError.internal();
      }
      const artifact = artifactRows[0];

      const head = await this.storage.headObject(artifact.objectKey);
      if (!head) {
        throw ApiError.validation({ upload: 'object not found — upload has not completed' });
      }
      if (head.contentLength !== artifact.byteLength) {
        throw ApiError.validation({ upload: `byte length mismatch: declared ${artifact.byteLength}, stored ${head.contentLength}` });
      }
      const storedSha = head.metadata['sha256'];
      const declaredSha = Buffer.from(artifact.sha256).toString('hex');
      if (storedSha !== declaredSha) {
        throw ApiError.validation({ upload: 'bound sha256 metadata mismatch — object does not match the signed policy' });
      }

      const updated = await tx
        .update(uploadSessions)
        .set({ state: 'UPLOADED', updatedAt: new Date().toISOString() })
        .where(eq(uploadSessions.id, session.id))
        .returning();
      await tx
        .update(artifacts)
        .set({ contentTypeDetected: artifact.contentTypeDeclared, updatedAt: new Date().toISOString() })
        .where(eq(artifacts.id, artifact.id));
      return updated[0];
    });
  }

  async getUploadSession(orgId: string, sessionId: string): Promise<UploadSession | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(sessionId, 'sessionId');
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).limit(1));
    return rows[0] ?? null;
  }

  // ── Claim-check facade (7 checks — ledger 4.11/5.12) ────────────────────

  /**
   * Dereference an artifact with FRESH authorization. Checks: (1) artifact
   * exists + purpose allowlisted by DDL, (2) org scope match, (3) expiry,
   * (4) checksum present (32 bytes), (5) byte-length bounds, (6) content-type
   * allowlist, (7) deletion/scan state. Returns a short-TTL presigned GET —
   * an opaque capability, never a stable URL.
   */
  async dereference(input: {
    orgId: string;
    artifactId: string;
    expectedPurpose?: string;
    maxBytes?: number;
  }): Promise<{ artifact: Artifact; accessUrl: string; expiresIn: number }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.artifactId, 'artifactId');

    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx.select().from(artifacts).where(and(eq(artifacts.id, input.artifactId), eq(artifacts.organizationId, input.orgId))).limit(1),
    );
    const artifact = rows[0];
    // (1) exists — DDL enforces the purpose allowlist, so existence covers it.
    if (!artifact) {
      throw ApiError.notFound('artifact');
    }
    // (2) scope: expected purpose binding (e.g. a CHECKPOINT ref cannot be read as SOURCE_DOCUMENT).
    if (input.expectedPurpose && artifact.purpose !== input.expectedPurpose) {
      throw ApiError.forbidden(`artifact purpose ${artifact.purpose} does not match expected ${input.expectedPurpose}`);
    }
    // (3) expiry.
    if (artifact.expiresAt && Date.parse(artifact.expiresAt) < Date.now()) {
      throw ApiError.forbidden('artifact expired');
    }
    // (4) checksum present and exactly 32 bytes.
    if (!artifact.sha256 || Buffer.from(artifact.sha256).length !== 32) {
      throw ApiError.internal();
    }
    // (5) byte-length bounds.
    const maxBytes = input.maxBytes ?? env.KNOWLEDGE_MAX_UPLOAD_BYTES;
    if (artifact.byteLength <= 0 || artifact.byteLength > maxBytes) {
      throw ApiError.forbidden('artifact byte length out of bounds');
    }
    // (6) content-type allowlist.
    if (!MEDIA_TYPE_ALLOWLIST.includes(artifact.contentTypeDetected ?? artifact.contentTypeDeclared)) {
      throw ApiError.forbidden('artifact content type is not allowlisted');
    }
    // (7) deletion / scan state.
    if (artifact.state !== 'active') {
      throw ApiError.forbidden('artifact is not active');
    }
    if (artifact.scanStatus === 'infected') {
      throw ApiError.forbidden('artifact is quarantined');
    }

    const download = this.storage.presignDownload({ key: artifact.objectKey, expiresIn: 300 });
    return { artifact, accessUrl: download.url, expiresIn: download.expiresIn };
  }

  /** Compute sha256 helper for callers that stream bytes (not used on API path). */
  static sha256Hex(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}
