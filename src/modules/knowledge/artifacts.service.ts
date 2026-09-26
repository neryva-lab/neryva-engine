import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../common/infra/storage/storage.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { env } from '../../common/config/env';
import { Artifact, UploadSession } from './schema';
import { ARTIFACT_PURPOSES } from './schema';
import { normalizeSourceSlug } from './source-slug';
import { ARTIFACT_REPOSITORY, DOCUMENT_REPOSITORY, UPLOAD_SESSION_REPOSITORY } from './repositories/repository-tokens';
import { IArtifactRepository } from './repositories/artifact.repository';
import { IDocumentRepository } from './repositories/document.repository';
import { IUploadSessionRepository } from './repositories/upload-session.repository';
import type { NewArtifact, NewUploadSession } from './repositories/repository-types';

/**
 * Artifacts — the claim-check facade (Phase 7, ledger 7.1/7.2/7.9 + MCP 5.12).
 *
 * Engine owns metadata + access state; object storage owns bytes. Object
 * keys are tenant-bound `org/{orgId}/{purpose}/{uuid}` — never user-supplied.
 * Dereferencing an artifact is a FRESH authorization pass (the 7 checks);
 * an ArtifactRef is a capability, not a Bearer <redacted>
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
    @Inject(UPLOAD_SESSION_REPOSITORY) private readonly sessions: IUploadSessionRepository,
    @Inject(ARTIFACT_REPOSITORY) private readonly artifactsRepo: IArtifactRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: IDocumentRepository,
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
    /** E-2: optional pin address + display title intents. */
    sourceSlug?: string | null;
    title?: string | null;
    /** A4-11: optional re-ingestion target — append a new version instead of minting a document. */
    targetDocumentId?: string | null;
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
    // A4-11: version upload — target an existing document instead of minting
    // one. Verified at authorize time (same verify-at-authorize pattern the
    // ingestion worker uses at claim time): 404 for missing/foreign-org,
    // 409 for retired (retire is terminal for manual documents), 422 when a
    // slug intent is also sent (the pin address is immutable on versions).
    // No slug reservation: no new document means no slug to reserve. The
    // title intent is ignored for version uploads (the console never sends
    // it) — the document keeps its title.
    let targetDocumentId: string | null = null;
    const wantsVersion = input.targetDocumentId !== undefined && input.targetDocumentId !== null && input.targetDocumentId !== '';
    if (wantsVersion) {
      assertUuid(input.targetDocumentId as string, 'targetDocumentId');
      if (input.sourceSlug !== undefined && input.sourceSlug !== null && input.sourceSlug !== '') {
        throw ApiError.validation({ target_document_id: 'source_slug is immutable on a version upload' });
      }
      const target = await this.documents.findVersionTarget(input.orgId, input.targetDocumentId as string);
      if (!target) {
        throw ApiError.notFound('document');
      }
      if (target.state === 'retired') {
        throw ApiError.conflict('version upload to a retired document is not allowed', { reason: 'version_target_retired' });
      }
      targetDocumentId = target.id;
    }
    // E-2: slug intent is validated + reserved NOW (fail fast at authorize
    // time, not deep in the ingestion worker). NULL = derive at ingestion.
    // Skipped entirely for version uploads (no new document).
    let sourceSlug: string | null = null;
    if (targetDocumentId === null && input.sourceSlug !== undefined && input.sourceSlug !== null && input.sourceSlug !== '') {
      sourceSlug = normalizeSourceSlug(input.sourceSlug);
      if (await this.documents.isSourceSlugTaken(input.orgId, sourceSlug)) {
        throw ApiError.conflict('source_slug is already taken in this organization', { reason: 'source_slug_taken' });
      }
    }
    let title: string | null = null;
    // A4-11: title intent is ignored for version uploads — the document keeps
    // its title (the console never sends one for a version).
    if (targetDocumentId === null && input.title !== undefined && input.title !== null && input.title !== '') {
      title = input.title.trim().slice(0, 256);
      if (title.length === 0) {
        throw ApiError.validation({ title: 'must not be blank' });
      }
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

    const newArtifact: NewArtifact = {
      id: artifactId,
      organizationId: input.orgId,
      purpose: input.purpose,
      objectKey,
      contentTypeDeclared: input.mediaType,
      byteLength: input.byteLength,
      sha256: Buffer.from(input.sha256Hex, 'hex'),
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), // unfinished uploads age out
    };
    const newSession: NewUploadSession = {
      id: sessionId,
      organizationId: input.orgId,
      purpose: input.purpose,
      artifactId,
      mediaType: input.mediaType,
      byteLength: input.byteLength,
      state: 'CREATED',
      sourceSlug,
      title,
      targetDocumentId,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      createdBy: input.createdBy,
    };
    const result = await this.sessions.createWithArtifact(input.orgId, newArtifact, newSession);

    await this.audit.add({
      action: 'artifact.upload_authorized',
      resourceType: 'artifact',
      resourceId: artifactId,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { purpose: input.purpose, media_type: input.mediaType, byte_length: input.byteLength, ...(sourceSlug ? { source_slug: sourceSlug } : {}) },
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
    const pair = await this.sessions.getSessionWithArtifact(input.orgId, input.sessionId);
    if (!pair) {
      throw ApiError.notFound('upload session');
    }
    const { session, artifact } = pair;
    if (session.state !== 'CREATED') {
      throw ApiError.conflict('upload session is not awaiting completion', { state: session.state });
    }

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

    const claimed = await this.sessions.claimUploaded(input.orgId, input.sessionId, artifact.contentTypeDeclared);
    if (!claimed) {
      throw ApiError.conflict('upload session is not awaiting completion', { state: session.state });
    }
    return claimed;
  }

  async getUploadSession(orgId: string, sessionId: string): Promise<UploadSession | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(sessionId, 'sessionId');
    const pair = await this.sessions.getSessionWithArtifact(orgId, sessionId);
    return pair?.session ?? null;
  }

  // ── Documents (E-2 mapping surface) ─────────────────────────────────────

  /** Org document inventory for the source-mapping UI (slug/title/state, newest first). */
  async listDocuments(orgId: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    assertUuid(orgId, 'orgId');
    const take = Math.min(Math.max(1, limit ?? 50), 200);
    const rows = await this.documents.listInventory(orgId, take);
    // Fresh literals keep the legacy raw-SQL column set exactly
    // (interfaces without an index signature are not assignable to the
    // declared Array<Record<string, unknown>> return type).
    return rows.map((r) => ({
      id: r.id,
      source_slug: r.source_slug,
      title: r.title,
      state: r.state,
      updated_at: r.updated_at,
      latest_version: r.latest_version,
    }));
  }

  /**
   * Bind a pin address to a document (E-2 mapping primitive for connector
   * docs and template-required slugs). Existing pins referencing the OLD
   * slug resolve visibly unresolved at next publish — rename never rewrites
   * history. Collision → 409, never silent suffixing (explicit admin choice).
   */
  async renameDocumentSourceSlug(input: { orgId: string; documentId: string; sourceSlug: string; actor: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.documentId, 'documentId');
    const slug = normalizeSourceSlug(input.sourceSlug);
    const outcome = await this.documents.renameSourceSlug(input.orgId, input.documentId, slug);
    if (outcome === 'not_found') {
      throw ApiError.notFound('document');
    }
    if (outcome === 'slug_taken') {
      throw ApiError.conflict('source_slug is already taken in this organization', { reason: 'source_slug_taken' });
    }
    if (outcome === 'unchanged') {
      return;
    }
    await this.audit.add({
      action: 'document.source_slug_renamed',
      resourceType: 'document',
      resourceId: input.documentId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { to: slug },
    });
  }

  /**
   * A4-01 — document preview: the stored text the row's pin resolves to.
   * Latest-version chunks in sequence order, windowed (server caps the
   * window and reports the truncation so the UI never implies the whole
   * text is shown).
   *
   * A4-12 — preview enforces the same read gates as the search workbench
   * (the bypass was accidental, not designed): document state='ready',
   * artifact active + scan clean/skipped + unexpired, retrieval_acl
   * visibility (organization-wide, or private-to-the-calling-account), and
   * the P0-1 source-ACL filter. A document failing any gate is unreachable
   * here exactly as it is unreachable by retrieval — 404, not 403, so the
   * existence of a non-visible document is never disclosed.
   */
  async getDocumentPreview(input: {
    orgId: string;
    documentId: string;
    chunkLimit?: number;
    accountId: string;
    callerEmails?: string[];
  }): Promise<{
    document: { id: string; source_slug: string; title: string | null; state: string; latest_version: number | null };
    total_chunks: number;
    truncated: boolean;
    chunks: Array<{ sequence: number; text: string; source_range: unknown }>;
  }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.documentId, 'documentId');
    assertUuid(input.accountId, 'accountId');
    const chunkLimit = Math.min(Math.max(1, input.chunkLimit ?? 10), 50);
    const preview = await this.documents.readPreview({
      orgId: input.orgId,
      documentId: input.documentId,
      accountId: input.accountId,
      callerEmails: input.callerEmails ?? [],
      chunkLimit,
    });
    if (!preview) {
      throw ApiError.notFound('document');
    }
    return {
      document: {
        id: preview.id,
        source_slug: preview.source_slug,
        title: preview.title,
        state: preview.state,
        latest_version: preview.version,
      },
      total_chunks: preview.chunkCount,
      truncated: preview.chunkCount > preview.chunks.length,
      chunks: preview.chunks.map((c) => ({ sequence: c.sequence, text: c.text, source_range: c.sourceRange })),
    };
  }

  /**
   * A4-05 — console removal is a tombstone (state='retired'), the same
   * terminal state connector deletions use: unreachable by retrieval
   * (retrieval constrains documents to state='ready'), the mapping kept so
   * history and existing pins stay answerable. Audited like the rename path.
   */
  async retireDocument(input: { orgId: string; documentId: string; actor: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.documentId, 'documentId');
    const outcome = await this.documents.retire(input.orgId, input.documentId);
    if (outcome === 'not_found') {
      throw ApiError.notFound('document');
    }
    if (outcome === 'retired') {
      await this.audit.add({
        action: 'document.retired',
        resourceType: 'document',
        resourceId: input.documentId,
        actorType: 'account',
        actorId: input.actor,
        tenantId: input.orgId,
        details: {},
      });
    }
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

    const artifact = await this.artifactsRepo.findById(input.orgId, input.artifactId);
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
