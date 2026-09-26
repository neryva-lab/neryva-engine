import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { StorageService } from '../../common/infra/storage/storage.service';
import { env } from '../../common/config/env';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { UploadSession, EMBEDDING_MODEL } from './schema';
import { deriveSourceSlug, normalizeSourceSlug } from './source-slug';
import { chunkText } from './text';
import { buildExtractorChain, TextExtractorPort } from './extraction.port';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import { AuditService } from '../../common/audit/audit.service';
import { EmbeddingService } from './embedding.service';
import { UPLOAD_SESSION_REPOSITORY, INGESTION_REPOSITORY, DOCUMENT_ACL_REPOSITORY } from './repositories/repository-tokens';
import type { IUploadSessionRepository } from './repositories/upload-session.repository';
import type { IIngestionRepository } from './repositories/ingestion.repository';
import type { IDocumentAclRepository } from './repositories/document-acl.repository';

/**
 * Ingestion pipeline worker — Phase 7.6 (ledger). Stage machine on
 * `upload_sessions`:
 *   UPLOADED -> SCANNING -> EXTRACTING -> INDEXING -> READY
 *                   |            |            |
 *                   +--> QUARANTINED / FAILED
 * Resume-safe: each stage claims one session with SKIP LOCKED + a
 * `locked_at` lease, advances it one step, and commits — a crash at any
 * boundary re-drives from the persisted state without duplicating chunks
 * (document_versions uniqueness + chunk sequence idempotency).
 *
 * Parsing is bounded (byte cap, chunk cap) and happens OUT of the API
 * process (this worker); the malware scanner is a port — the default
 * implementation marks `skipped` (no ClamAV in the dev stack) and is the
 * seam where a real scanner lands without touching the machine.
 */
export interface MalwareScannerPort {
  scan(input: { objectKey: string }): Promise<'clean' | 'infected' | 'skipped'>;
}

export class DefaultScanner implements MalwareScannerPort {
  async scan(_input: { objectKey: string }): Promise<'skipped'> {
    return 'skipped';
  }
}

const PARSER_VERSION = 'text-v1';
const CHUNK_CHARS = 1000;
const MAX_CHUNKS = 500;
const STALE_LOCK_MS = 5 * 60_000;

@Injectable()
export class KnowledgeIngestionWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(KnowledgeIngestionWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  private readonly extractors: TextExtractorPort[] = buildExtractorChain({
    ocrUrl: env.KNOWLEDGE_OCR_URL || undefined,
    transcribeUrl: env.KNOWLEDGE_TRANSCRIBE_URL || undefined,
  });

  constructor(
    @Inject(UPLOAD_SESSION_REPOSITORY) private readonly sessions: IUploadSessionRepository,
    @Inject(INGESTION_REPOSITORY) private readonly ingestion: IIngestionRepository,
    @Inject(DOCUMENT_ACL_REPOSITORY) private readonly documentAcl: IDocumentAclRepository,
    private readonly storage: StorageService,
    private readonly embedding: EmbeddingService,
    private readonly scanner: DefaultScanner,
    private readonly configPublish: ConfigPublishService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED) {
      return; // worker host flag governs all background workers
    }
    this.timer = setInterval(() => void this.tick(), env.OUTBOX_DISPATCH_INTERVAL_MS);
    this.timer.unref();
    KnowledgeIngestionWorker.logger.log('knowledge ingestion worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const session = await this.claimOne();
      if (!session) return;
      try {
        await this.advance(session);
      } finally {
        await this.releaseLock(session.id);
      }
    } catch (err) {
      KnowledgeIngestionWorker.logger.warn(`ingestion tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Claim one in-flight session (oldest first, SKIP LOCKED, stale lock reclaim). */
  private async claimOne(): Promise<UploadSession | null> {
    return this.sessions.claimNext(
      ['UPLOADED', 'SCANNING', 'EXTRACTING', 'INDEXING'],
      new Date(Date.now() - STALE_LOCK_MS),
    );
  }

  private async releaseLock(sessionId: string): Promise<void> {
    await this.sessions.releaseLock(sessionId);
  }

  /** Advance the claimed session by exactly one stage. */
  private async advance(session: UploadSession): Promise<void> {
    switch (session.state) {
      case 'UPLOADED':
        return this.scanStage(session);
      case 'SCANNING':
        return this.extractStage(session);
      case 'EXTRACTING':
        return this.indexStage(session);
      case 'INDEXING':
        return this.readyStage(session);
      default:
        return;
    }
  }

  private async scanStage(session: UploadSession): Promise<void> {
    const verdict = await this.scannerOrThrow(session);
    await this.sessions.applyScanVerdict({
      sessionId: session.id,
      artifactId: session.artifactId,
      verdict,
      at: new Date(),
    });
  }

  private async scannerOrThrow(session: UploadSession): Promise<'clean' | 'infected' | 'skipped'> {
    const artifact = await this.sessions.getArtifactForExtraction(session.artifactId);
    if (!artifact) throw new Error(`artifact ${session.artifactId} vanished during scan stage`);
    return this.scanner.scan({ objectKey: artifact.objectKey });
  }

  private async extractStage(session: UploadSession): Promise<void> {
    try {
      // Validate fetchability + bounds now; the INDEXING stage re-fetches.
      // Stateless stages keep the machine crash-safe without staging state.
      await this.fetchObjectText(session);
      await this.sessions.markExtracting(session.id, new Date());
    } catch (err) {
      await this.fail(session, `extraction failed: ${(err as Error).message}`);
    }
  }

  private async indexStage(session: UploadSession): Promise<void> {
    try {
      const text = await this.fetchObjectText(session);
      // E-2: resolve the pin address BEFORE inserting. Explicit session
      // intent wins; otherwise derive deterministically from the artifact
      // (stable across worker retries of the same session).
      const slug = session.sourceSlug ?? deriveSourceSlug(session.artifactId);
      try {
        normalizeSourceSlug(slug);
      } catch {
        throw new Error(`derived source slug is invalid for document addressing (session ${session.id})`);
      }
      const title = (session.title ?? '').trim().slice(0, 256) || slug;

      // FL-2.3 — per-org chunking controls (`knowledge_config` published
      // config). Falls back to the platform defaults when absent.
      const orgConfig = await this.orgKnowledgeConfig(session.organizationId);
      const pieces = chunkText(text, orgConfig.chunkSize, MAX_CHUNKS, orgConfig.chunkOverlap);
      const embeddingModel = orgConfig.embeddingModel || EMBEDDING_MODEL;
      if (pieces.length === 0) {
        throw new Error('document produced no chunks (empty content)');
      }
      // Embeddings are computed OUTSIDE the persistence transaction (no
      // network I/O in the repository); the vectors arrive pre-computed.
      const vectors = await this.embedding.embed(pieces.map((p) => p.text));

      // P0-1: connector provenance → external-id map (drives delete
      // propagation + re-sync versioning). Parsed here; the repository
      // asserts the map best-effort inside the stage transaction.
      const connectorRef = (session.connectorRef ?? null) as {
        account_id?: unknown;
        provider?: unknown;
        external_id?: unknown;
      } | null;
      const connector =
        typeof connectorRef?.account_id === 'string' &&
        typeof connectorRef?.provider === 'string' &&
        typeof connectorRef?.external_id === 'string'
          ? {
              accountId: connectorRef.account_id,
              provider: connectorRef.provider,
              externalId: connectorRef.external_id,
            }
          : null;

      await this.ingestion.indexDocumentVersion({
        orgId: session.organizationId,
        sessionId: session.id,
        artifactId: session.artifactId,
        targetDocumentId: session.targetDocumentId ?? null,
        sourceSlug: slug,
        title,
        connectorRef: connector,
        contentSha256: Buffer.from(sha256Hex(text), 'hex'),
        parserVersion: PARSER_VERSION,
        embeddingModel,
        chunks: pieces.map((p, i) => ({
          sequence: i,
          byteStart: p.byteStart,
          byteEnd: p.byteEnd,
          chunkHash: canonicalHash(p.text).slice(0, 64),
          text: p.text,
          vector: vectors[i] ?? [],
        })),
        at: new Date(),
      });
    } catch (err) {
      await this.fail(session, `indexing failed: ${(err as Error).message}`);
    }
  }

  private async readyStage(session: UploadSession): Promise<void> {
    const isVersion = session.targetDocumentId != null;
    const orgConfig = await this.orgKnowledgeConfig(session.organizationId);
    // P0-1: the source-ACL verdict arrives as structured intent; the
    // repository applies it (open clears, restricted replaces) inside the
    // same READY-stage transaction.
    const intent = (session.sourceAcl ?? null) as { mode?: unknown; principals?: unknown } | null;
    const ref = (session.connectorRef ?? null) as { provider?: unknown } | null;
    const { documentId } = await this.documentAcl.publishDocumentReady({
      orgId: session.organizationId,
      sessionId: session.id,
      artifactId: session.artifactId,
      targetDocumentId: session.targetDocumentId ?? null,
      embeddingModel: orgConfig.embeddingModel || EMBEDDING_MODEL,
      sourceAcl:
        intent?.mode === 'restricted'
          ? {
              mode: 'restricted',
              principals: (Array.isArray(intent.principals) ? intent.principals : []) as Array<{
                kind: string;
                id: string;
                email?: string;
              }>,
            }
          : intent?.mode === 'open'
            ? { mode: 'open', principals: [] }
            : null,
      connectorProvider: typeof ref?.provider === 'string' ? ref.provider : 'unknown',
      at: new Date(),
    });
    // A4-11: audit the version append. The worker acts on the session
    // creator's behalf (actor = the account that authorized the upload);
    // NULL when the session predates createdBy tracking — never a
    // fabricated identity.
    if (isVersion && documentId) {
      const version = await this.documentAcl.latestVersion(session.organizationId, documentId);
      await this.audit.add({
        action: 'document.version_added',
        resourceType: 'document',
        resourceId: documentId,
        actorType: 'account',
        actorId: session.createdBy ?? null,
        tenantId: session.organizationId,
        details: { version, session_id: session.id },
      });
    }
    KnowledgeIngestionWorker.logger.log(`upload session ${session.id} ingested (READY)`);
  }

  /**
   * FL-2.3 — per-org knowledge config. The embedding model tags every
   * vector the pipeline writes (a real per-org provider lands with BYOK,
   * FL-2.18); chunk size/overlap shape the lexical + vector granularity.
   */
  private async orgKnowledgeConfig(orgId: string): Promise<{ embeddingModel: string; chunkSize: number; chunkOverlap: number }> {
    const published = await this.configPublish.latest(orgId, 'knowledge_config', null);
    const payload = (published?.payload ?? {}) as { embedding_model?: string; chunk_size?: number; chunk_overlap?: number };
    return {
      embeddingModel: payload.embedding_model ?? EMBEDDING_MODEL,
      chunkSize: Math.min(Math.max(200, payload.chunk_size ?? CHUNK_CHARS), 8000),
      chunkOverlap: Math.min(Math.max(0, payload.chunk_overlap ?? 0), 1000),
    };
  }

  private async fail(session: UploadSession, message: string): Promise<void> {
    await this.sessions.markFailed({
      sessionId: session.id,
      artifactId: session.artifactId,
      error: message.slice(0, 4000),
      at: new Date(),
    });
    KnowledgeIngestionWorker.logger.warn(`upload session ${session.id} FAILED: ${message}`);
  }

  /** Bounded object download via a fresh presigned GET — never in the API process. */
  private async fetchObjectText(session: UploadSession): Promise<string> {
    const artifact = await this.sessions.getArtifactForExtraction(session.artifactId);
    if (!artifact) throw new Error('artifact vanished during extraction');
    const mediaType = artifact.contentTypeDetected ?? artifact.contentTypeDeclared;
    // FL-2.6 - extractor dispatch by media type (plain text -> OCR ->
    // transcription, in priority order). Absent worker URLs mean the media
    // family is unsupported: a loud pipeline failure, never silent garbage.
    const extractor = this.extractors.find((e) => e.supports(mediaType));
    if (!extractor) {
      throw new Error(`unsupported media type for text extraction: ${mediaType}`);
    }
    const download = this.storage.presignDownload({ key: artifact.objectKey, expiresIn: 120 });
    const response = await fetch(download.url);
    if (!response.ok) {
      throw new Error(`object fetch failed with status ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > env.KNOWLEDGE_MAX_UPLOAD_BYTES) {
      throw new Error('object exceeds the ingestion byte bound');
    }
    const extraction = await extractor.extract({ bytes: buffer, mediaType });
    return extraction.text;
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
