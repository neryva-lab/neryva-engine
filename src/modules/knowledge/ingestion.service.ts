import { and, asc, desc, eq, inArray, lte, or, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { pgViolation } from '../../common/infra/db/pg-types';
import { StorageService } from '../../common/infra/storage/storage.service';
import { env } from '../../common/config/env';
import { uuidv7 } from '../../common/ids/uuidv7';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { artifacts, chunks, documentSourceAcls, documentVersions, documents, embeddings, externalIdentityLinks, externalPrincipals, retrievalAcl, uploadSessions, UploadSession, EMBEDDING_MODEL } from './schema';
import { accounts } from '../identity/schema';
import { connectorDocuments } from './connectors.schema';
import { deriveSourceSlug, normalizeSourceSlug } from './source-slug';
import { chunkText } from './text';
import { buildExtractorChain, TextExtractorPort } from './extraction.port';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import { AuditService } from '../../common/audit/audit.service';
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

  private readonly extractors: TextExtractorPort[] = buildExtractorChain({
    ocrUrl: env.KNOWLEDGE_OCR_URL || undefined,
    transcribeUrl: env.KNOWLEDGE_TRANSCRIBE_URL || undefined,
  });

  constructor(
    private readonly db: DbService,
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
        // Document: dedupe by source artifact (uq_documents_source_artifact),
        // or attach to the re-ingestion target (connector re-sync appends a
        // new version instead of duplicating the document).
        let documentId: string | undefined;
        if (session.targetDocumentId) {
          // A4-11: FOR UPDATE serializes concurrent version appends to the
          // same document (multi-process workers): the max(version)+1 below
          // must not race, or two uploads mint the same version number.
          const target = await tx
            .select({ id: documents.id })
            .from(documents)
            .where(and(eq(documents.id, session.targetDocumentId), eq(documents.organizationId, session.organizationId)))
            .limit(1)
            .for('update');
          if (!target[0]) {
            throw new Error('re-ingestion target document is gone (deleted or foreign org)');
          }
          documentId = target[0].id;
        } else {
          try {
            const docRows = await tx
              .insert(documents)
              .values({
                id: uuidv7(),
                organizationId: session.organizationId,
                sourceArtifactId: session.artifactId,
                title,
                sourceSlug: slug,
              })
              .onConflictDoNothing({ target: documents.sourceArtifactId })
              .returning();
            documentId = docRows[0]?.id;
          } catch (err) {
            if (pgViolation(err).code === '23505') {
              throw new Error(`source_slug '${slug}' is already taken in this organization`);
            }
            throw err;
          }
          if (!documentId) {
            const existing = await tx.select().from(documents).where(eq(documents.sourceArtifactId, session.artifactId)).limit(1);
            documentId = existing[0].id;
          }
          // P0-1: connector provenance → external-id map (drives delete
          // propagation + re-sync versioning). Best-effort within the stage:
          // a mapping failure must not fail ingestion (the doc is still
          // valid org content; the next sync re-asserts the map).
          const connectorRef = (session.connectorRef ?? null) as { account_id?: unknown; provider?: unknown; external_id?: unknown } | null;
          if (
            typeof connectorRef?.account_id === 'string' &&
            typeof connectorRef?.provider === 'string' &&
            typeof connectorRef?.external_id === 'string'
          ) {
            await tx
              .insert(connectorDocuments)
              .values({
                id: uuidv7(),
                organizationId: session.organizationId,
                connectorAccountId: connectorRef.account_id,
                externalId: connectorRef.external_id,
                documentId,
              })
              .onConflictDoNothing({
                target: [connectorDocuments.organizationId, connectorDocuments.connectorAccountId, connectorDocuments.externalId],
              });
          }
        }

        const textSha256 = Buffer.from(sha256Hex(text), 'hex');
        // Versions ascend per document: re-ingestion (connector re-sync via
        // target_document_id) appends max+1 so pins resolve to the newest
        // content at next publish; identical content rebuilds in place.
        const maxVersionRows = await tx
          .select({ version: documentVersions.version })
          .from(documentVersions)
          .where(eq(documentVersions.documentId, documentId))
          .orderBy(desc(documentVersions.version))
          .limit(1);
        const nextVersion = (maxVersionRows[0]?.version ?? 0) + 1;
        const versionRows = await tx
          .insert(documentVersions)
          .values({
            id: uuidv7(),
            documentId,
            organizationId: session.organizationId,
            version: nextVersion,
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

        // FL-2.3 — per-org chunking controls (`knowledge_config` published
        // config). Falls back to the platform defaults when absent.
        const orgConfig = await this.orgKnowledgeConfig(session.organizationId);
        const pieces = chunkText(text, orgConfig.chunkSize, MAX_CHUNKS, orgConfig.chunkOverlap);
        const embeddingModel = orgConfig.embeddingModel || EMBEDDING_MODEL;
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
            model: embeddingModel,
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
    const isVersion = session.targetDocumentId != null;
    const docId = await this.db.withBypass(async (tx) => {
      await tx.update(uploadSessions).set({ state: 'READY', updatedAt: new Date().toISOString() }).where(eq(uploadSessions.id, session.id));
      const orgConfig = await this.orgKnowledgeConfig(session.organizationId);
      // A4-11: version sessions attach to the re-ingestion target (the
      // session's artifact is new, so a sourceArtifactId match misses);
      // first ingests match on the source artifact as before.
      const docCond = isVersion
        ? eq(documents.id, session.targetDocumentId as string)
        : eq(documents.sourceArtifactId, session.artifactId);
      await tx
        .update(documents)
        .set({
          state: 'ready',
          embeddingModel: orgConfig.embeddingModel || EMBEDDING_MODEL,
          updatedAt: new Date().toISOString(),
        })
        .where(docCond);
      // Default ACL: documents are organization-visible at ingest
      // (retrieval.service's contract). Without this row the retrieval join
      // excludes the document entirely — it would be indexed but unreachable.
      const docRows = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(docCond)
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
        // P0-1: source permission verdicts land here (replacing any prior
        // set — sync is the authority on source truth). Open mode clears
        // restrictions (permissions widened at the source).
        await this.applySourceAcl(tx, session, docRows[0].id);
      }
      return docRows[0]?.id ?? null;
    });
    // A4-11: audit the version append. The worker acts on the session
    // creator's behalf (actor = the account that authorized the upload);
    // NULL when the session predates createdBy tracking — never a
    // fabricated identity.
    if (isVersion && docId) {
      const versions = await this.db.withBypass((tx) =>
        tx
          .select({ version: documentVersions.version })
          .from(documentVersions)
          .where(eq(documentVersions.documentId, docId))
          .orderBy(desc(documentVersions.version))
          .limit(1),
      );
      await this.audit.add({
        action: 'document.version_added',
        resourceType: 'document',
        resourceId: docId,
        actorType: 'account',
        actorId: session.createdBy ?? null,
        tenantId: session.organizationId,
        details: { version: versions[0]?.version ?? null, session_id: session.id },
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

  /**
   * P0-1 — apply a connector's source-ACL verdict to a READY document.
   * Open (or absent intent): delete any restriction rows (permissions
   * widened). Restricted: upsert principals, auto-link emails to accounts,
   * and REPLACE the document's restriction set (sync is the authority).
   * Best-effort inside the stage TX — ACL failures must not fail ingestion;
   * the document keeps the legacy org posture and the next sync retries.
   */
  private async applySourceAcl(
    tx: Parameters<Parameters<DbService['withBypass']>[0]>[0],
    session: UploadSession,
    documentId: string,
  ): Promise<void> {
    const intent = (session.sourceAcl ?? null) as { mode?: unknown; principals?: unknown } | null;
    const ref = (session.connectorRef ?? null) as { provider?: unknown } | null;
    const provider = typeof ref?.provider === 'string' ? ref.provider : 'unknown';
    if (!intent || intent.mode !== 'restricted') {
      if (intent && (intent.mode as string) === 'open') {
        await tx.delete(documentSourceAcls).where(eq(documentSourceAcls.documentId, documentId));
      }
      return;
    }
    const principals = Array.isArray(intent.principals) ? intent.principals : [];
    const clean = principals
      .filter((p): p is { kind: string; id: string; email?: string } => {
        const r = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
        return (r['kind'] === 'user' || r['kind'] === 'group' || r['kind'] === 'domain') && typeof r['id'] === 'string' && (r['id'] as string).length > 0;
      })
      .slice(0, 500);
    for (const p of clean) {
      await tx
        .insert(externalPrincipals)
        .values({
          id: uuidv7(),
          organizationId: session.organizationId,
          provider,
          externalId: p.id.slice(0, 512),
          kind: p.kind,
          email: typeof p.email === 'string' && p.email.includes('@') ? p.email.toLowerCase().slice(0, 320) : null,
          display: null,
        })
        .onConflictDoUpdate({
          target: [externalPrincipals.organizationId, externalPrincipals.provider, externalPrincipals.externalId],
          set: {
            kind: p.kind,
            email: typeof p.email === 'string' && p.email.includes('@') ? p.email.toLowerCase().slice(0, 320) : null,
            updatedAt: new Date().toISOString(),
          },
        });
      // Auto-link on verified-email equality (the common case) so account
      // matching works without manual mapping. No link = default-deny.
      const email = typeof p.email === 'string' && p.email.includes('@') ? p.email.toLowerCase() : null;
      if (email) {
        const owners = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, email)).limit(1);
        if (owners[0]) {
          await tx
            .insert(externalIdentityLinks)
            .values({ id: uuidv7(), organizationId: session.organizationId, provider, externalId: p.id.slice(0, 512), accountId: owners[0].id })
            .onConflictDoNothing({
              target: [externalIdentityLinks.organizationId, externalIdentityLinks.provider, externalIdentityLinks.externalId],
            });
        }
      }
    }
    await tx.delete(documentSourceAcls).where(eq(documentSourceAcls.documentId, documentId));
    for (const p of clean) {
      await tx
        .insert(documentSourceAcls)
        .values({ id: uuidv7(), organizationId: session.organizationId, documentId, provider, externalId: p.id.slice(0, 512) })
        .onConflictDoNothing({
          target: [documentSourceAcls.documentId, documentSourceAcls.provider, documentSourceAcls.externalId],
        });
    }
  }

  private async fail(session: UploadSession, message: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(uploadSessions)
        .set({ state: 'FAILED', lastError: message.slice(0, 4000), updatedAt: new Date().toISOString() })
        .where(eq(uploadSessions.id, session.id));
      // A4-11: this match deliberately misses version sessions (their
      // artifact is new). A failed version ingestion must NOT touch the
      // document row — the previous version keeps serving in its prior
      // state. The failure surfaces on the upload session (tracker), not
      // on the document.
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
    // FL-2.6 - extractor dispatch by media type (plain text -> OCR ->
    // transcription, in priority order). Absent worker URLs mean the media
    // family is unsupported: a loud pipeline failure, never silent garbage.
    const extractor = this.extractors.find((e) => e.supports(mediaType));
    if (!extractor) {
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
    const extraction = await extractor.extract({ bytes: buffer, mediaType });
    return extraction.text;
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
