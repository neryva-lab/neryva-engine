import { and, asc, eq, inArray, lte, or, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { env } from '../../common/config/env';
import { uuidv7 } from '../../common/ids/uuidv7';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { artifacts, chunks, documentVersions, documents, embeddings, retrievalAcl, uploadSessions, UploadSession, EMBEDDING_MODEL } from './schema';
import { chunkText } from './text';
import { EmbeddingService } from './embedding.service';

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

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly embedding: EmbeddingService,
    private readonly scanner: DefaultScanner,
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
    const staleBefore = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .select()
        .from(uploadSessions)
        .where(
          and(
            inArray(uploadSessions.state, ['UPLOADED', 'SCANNING', 'EXTRACTING', 'INDEXING']),
            or(isNull(uploadSessions.lockedAt), lte(uploadSessions.lockedAt, staleBefore)),
          ),
        )
        .orderBy(asc(uploadSessions.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return null;
      const updated = await tx
        .update(uploadSessions)
        .set({ lockedAt: new Date().toISOString() })
        .where(eq(uploadSessions.id, rows[0].id))
        .returning();
      return updated[0];
    });
  }

  private async releaseLock(sessionId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.update(uploadSessions).set({ lockedAt: null }).where(eq(uploadSessions.id, sessionId));
    });
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
    await this.db.withBypass(async (tx) => {
      if (verdict === 'infected') {
        await tx.update(uploadSessions).set({ state: 'QUARANTINED', updatedAt: new Date().toISOString() }).where(eq(uploadSessions.id, session.id));
        await tx.update(artifacts).set({ scanStatus: 'infected', updatedAt: new Date().toISOString() }).where(eq(artifacts.id, session.artifactId));
        return;
      }
      await tx
        .update(uploadSessions)
        .set({ state: 'SCANNING', updatedAt: new Date().toISOString() })
        .where(eq(uploadSessions.id, session.id));
      await tx
        .update(artifacts)
        .set({ scanStatus: verdict === 'skipped' ? 'skipped' : 'clean', updatedAt: new Date().toISOString() })
        .where(eq(artifacts.id, session.artifactId));
    });
  }

  private async scannerOrThrow(session: UploadSession): Promise<'clean' | 'infected' | 'skipped'> {
    const artifact = await this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`select object_key from artifacts where id = ${session.artifactId}::uuid limit 1`);
      return (rows.rows[0] as { object_key: string } | undefined)?.object_key;
    });
    if (!artifact) throw new Error(`artifact ${session.artifactId} vanished during scan stage`);
    return this.scanner.scan({ objectKey: artifact });
  }

  private async extractStage(session: UploadSession): Promise<void> {
    try {
      // Validate fetchability + bounds now; the INDEXING stage re-fetches.
      // Stateless stages keep the machine crash-safe without staging state.
      await this.fetchObjectText(session);
      await this.db.withBypass(async (tx) => {
        await tx
          .update(uploadSessions)
          .set({ state: 'EXTRACTING', updatedAt: new Date().toISOString(), lastError: null })
          .where(eq(uploadSessions.id, session.id));
      });
    } catch (err) {
      await this.fail(session, `extraction failed: ${(err as Error).message}`);
    }
  }

  private async indexStage(session: UploadSession): Promise<void> {
    try {
      const text = await this.fetchObjectText(session);
      await this.db.withBypass(async (tx) => {
        // Document: dedupe by source artifact (uq_documents_source_artifact).
        const docRows = await tx
          .insert(documents)
          .values({
            id: uuidv7(),
            organizationId: session.organizationId,
            sourceArtifactId: session.artifactId,
            title: `${session.purpose.toLowerCase()}-${session.id.slice(0, 8)}`,
          })
          .onConflictDoNothing({ target: documents.sourceArtifactId })
          .returning();
        let documentId = docRows[0]?.id;
        if (!documentId) {
          const existing = await tx.select().from(documents).where(eq(documents.sourceArtifactId, session.artifactId)).limit(1);
          documentId = existing[0].id;
        }

        const textSha256 = Buffer.from(sha256Hex(text), 'hex');
        const versionRows = await tx
          .insert(documentVersions)
          .values({
            id: uuidv7(),
            documentId,
            organizationId: session.organizationId,
            version: 1,
            sha256: textSha256,
            parserVersion: PARSER_VERSION,
          })
          .onConflictDoNothing()
          .returning();
        let versionId = versionRows[0]?.id;
        if (!versionId) {
          const existing = await tx
            .select()
            .from(documentVersions)
            .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.sha256, textSha256), eq(documentVersions.parserVersion, PARSER_VERSION)))
            .limit(1);
          versionId = existing[0].id;
          // Re-ingest of identical content: clear derived rows for a clean rebuild.
          await tx.delete(chunks).where(eq(chunks.documentVersionId, versionId));
        }

        const pieces = chunkText(text, CHUNK_CHARS, MAX_CHUNKS);
        if (pieces.length === 0) {
          throw new Error('document produced no chunks (empty content)');
        }
        const vectors = await this.embedding.embed(pieces.map((p) => p.text));
        for (let i = 0; i < pieces.length; i++) {
          const chunkRows = await tx
            .insert(chunks)
            .values({
              id: uuidv7(),
              documentVersionId: versionId,
              organizationId: session.organizationId,
              sequence: i,
              sourceRange: { byteStart: pieces[i].byteStart, byteEnd: pieces[i].byteEnd },
              chunkHash: canonicalHash(pieces[i].text).slice(0, 64),
              text: pieces[i].text,
            })
            .returning({ id: chunks.id });
          await tx.insert(embeddings).values({
            id: uuidv7(),
            chunkId: chunkRows[0].id,
            organizationId: session.organizationId,
            model: EMBEDDING_MODEL,
            embedding: vectors[i],
          });
        }

        await tx
          .update(uploadSessions)
          .set({ state: 'INDEXING', updatedAt: new Date().toISOString() })
          .where(eq(uploadSessions.id, session.id));
      });
    } catch (err) {
      await this.fail(session, `indexing failed: ${(err as Error).message}`);
    }
  }

  private async readyStage(session: UploadSession): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.update(uploadSessions).set({ state: 'READY', updatedAt: new Date().toISOString() }).where(eq(uploadSessions.id, session.id));
      await tx.update(documents).set({ state: 'ready', updatedAt: new Date().toISOString() }).where(eq(documents.sourceArtifactId, session.artifactId));
      // Default ACL: documents are organization-visible at ingest
      // (retrieval.service's contract). Without this row the retrieval join
      // excludes the document entirely — it would be indexed but unreachable.
      const docRows = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.sourceArtifactId, session.artifactId))
        .limit(1);
      if (docRows[0]) {
        await tx
          .insert(retrievalAcl)
          .values({
            id: uuidv7(),
            organizationId: session.organizationId,
            resourceType: 'document',
            resourceId: docRows[0].id,
            visibility: 'organization',
            scopeAccountId: null,
          })
          .onConflictDoNothing();
      }
    });
    KnowledgeIngestionWorker.logger.log(`upload session ${session.id} ingested (READY)`);
  }

  private async fail(session: UploadSession, message: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ state: 'FAILED', lastError: message.slice(0, 4000), updatedAt: new Date().toISOString() })
        .where(eq(uploadSessions.id, session.id));
      await tx.update(documents).set({ state: 'failed', updatedAt: new Date().toISOString() }).where(eq(documents.sourceArtifactId, session.artifactId));
    });
    KnowledgeIngestionWorker.logger.warn(`upload session ${session.id} FAILED: ${message}`);
  }

  /** Bounded object download via a fresh presigned GET — never in the API process. */
  private async fetchObjectText(session: UploadSession): Promise<string> {
    const artifactRows = await this.db.withBypass(async (tx) => {
      const rows = await tx.execute(sql`select object_key, content_type_detected, content_type_declared from artifacts where id = ${session.artifactId}::uuid limit 1`);
      return rows.rows[0] as { object_key: string; content_type_detected: string | null; content_type_declared: string } | undefined;
    });
    if (!artifactRows) throw new Error('artifact vanished during extraction');
    const mediaType = artifactRows.content_type_detected ?? artifactRows.content_type_declared;
    if (!mediaType.startsWith('text/') && mediaType !== 'application/json') {
      throw new Error(`unsupported media type for text extraction: ${mediaType}`);
    }
    const download = this.storage.presignDownload({ key: artifactRows.object_key, expiresIn: 120 });
    const response = await fetch(download.url);
    if (!response.ok) {
      throw new Error(`object fetch failed with status ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > env.KNOWLEDGE_MAX_UPLOAD_BYTES) {
      throw new Error('object exceeds the ingestion byte bound');
    }
    return buffer.toString('utf8');
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
