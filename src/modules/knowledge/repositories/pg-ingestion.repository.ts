import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { chunks, documents, documentVersions, embeddings, uploadSessions } from '../schema';
import { connectorDocuments } from '../connectors.schema';
import type { IIngestionRepository } from './ingestion.repository';

/**
 * PostgreSQL implementation of `IIngestionRepository` (P3).
 *
 * Mechanical move of the `KnowledgeIngestionWorker.indexStage` SQL: one
 * `DbService.withBypass` transaction owning the whole INDEXING unit of work.
 * No transaction handle leaks through this interface.
 *
 * Preserved, NOT fixed (documented hazards):
 * - `max(version) + 1` races under concurrency; the `FOR UPDATE` on the
 *   re-ingest target only serializes target-append, not fresh inserts.
 * - the source-slug 23505 catch maps to a plain Error (worker fail path).
 *
 * What stays OUT (still the worker's job, precomputed before the call):
 * - source slug/title derivation + validation (pure functions)
 * - the content SHA-256 (`contentSha256` arrives as bytes)
 * - the org knowledge config (chunk size/overlap, embedding model)
 * - chunking (`chunkText`) + chunk hashes (`canonicalHash`)
 * - embedding vectors (the embedding service; never network I/O here)
 * - choosing `targetDocumentId` (the repo only takes the row lock)
 * - audit writes, tracing spans.
 */
export class PgIngestionRepository implements IIngestionRepository {
  constructor(private readonly db: DbService) {}

  async indexDocumentVersion(input: {
    orgId: string;
    sessionId: string;
    artifactId: string;
    targetDocumentId: string | null;
    sourceSlug: string;
    title: string;
    connectorRef: { accountId: string; provider: string; externalId: string } | null;
    contentSha256: Uint8Array;
    parserVersion: string;
    embeddingModel: string;
    chunks: Array<{
      sequence: number;
      byteStart: number;
      byteEnd: number;
      chunkHash: string;
      text: string;
      vector: number[];
    }>;
    at: Date;
  }): Promise<{ documentId: string; versionId: string; version: number }> {
    const orgId = input.orgId;
    const atIso = input.at.toISOString();
    return this.db.withBypass(async (tx) => {
      // Document: dedupe by source artifact (uq_documents_source_artifact),
      // or attach to the re-ingestion target (connector re-sync appends a
      // new version instead of duplicating the document).
      let documentId: string;
      if (input.targetDocumentId) {
        // A4-11: FOR UPDATE serializes concurrent version appends to the
        // same document (multi-process workers): the max(version)+1 below
        // must not race, or two uploads mint the same version number.
        const target = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, input.targetDocumentId), eq(documents.organizationId, orgId)))
          .limit(1)
          .for('update');
        if (!target[0]) {
          throw new Error('re-ingestion target document is gone (deleted or foreign org)');
        }
        documentId = target[0].id;
      } else {
        let createdId: string | undefined;
        try {
          const docRows = await tx
            .insert(documents)
            .values({
              id: uuidv7(),
              organizationId: orgId,
              sourceArtifactId: input.artifactId,
              title: input.title,
              sourceSlug: input.sourceSlug,
            })
            .onConflictDoNothing({ target: documents.sourceArtifactId })
            .returning();
          createdId = docRows[0]?.id;
        } catch (err) {
          if (pgViolation(err).code === '23505') {
            throw new Error(`source_slug '${input.sourceSlug}' is already taken in this organization`);
          }
          throw err;
        }
        if (!createdId) {
          const existing = await tx
            .select()
            .from(documents)
            .where(eq(documents.sourceArtifactId, input.artifactId))
            .limit(1);
          createdId = existing[0].id;
        }
        documentId = createdId;
        // P0-1: connector provenance → external-id map (drives delete
        // propagation + re-sync versioning). Best-effort within the stage:
        // a mapping failure must not fail ingestion (the doc is still
        // valid org content; the next sync re-asserts the map).
        if (input.connectorRef) {
          await tx
            .insert(connectorDocuments)
            .values({
              id: uuidv7(),
              organizationId: orgId,
              connectorAccountId: input.connectorRef.accountId,
              externalId: input.connectorRef.externalId,
              documentId,
            })
            .onConflictDoNothing({
              target: [connectorDocuments.organizationId, connectorDocuments.connectorAccountId, connectorDocuments.externalId],
            });
        }
      }

      // Versions ascend per document: re-ingestion (connector re-sync via
      // target_document_id) appends max+1 so pins resolve to the newest
      // content at next publish; identical content rebuilds in place.
      // Content pre-check (mirrors the mongo lane): identical content
      // converges onto the existing version row — rebuild its chunks,
      // never mint a duplicate version.
      const contentHash = Buffer.from(input.contentSha256);
      const existingByContent = await tx
        .select({ id: documentVersions.id })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.sha256, contentHash),
            eq(documentVersions.parserVersion, input.parserVersion),
          ),
        )
        .limit(1);
      let versionId: string;
      let version: number;
      if (existingByContent[0]) {
        versionId = existingByContent[0].id;
        const vRow = await tx
          .select({ version: documentVersions.version })
          .from(documentVersions)
          .where(eq(documentVersions.id, versionId))
          .limit(1);
        version = vRow[0].version;
        // Re-ingest of identical content: clear derived rows for a clean rebuild.
        await tx.delete(chunks).where(eq(chunks.documentVersionId, versionId));
      } else {
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
            organizationId: orgId,
            version: nextVersion,
            sha256: contentHash,
            parserVersion: input.parserVersion,
          })
          .onConflictDoNothing()
          .returning();
        versionId = versionRows[0]?.id;
        if (!versionId) {
          // Lost the version-number race: read back the winner.
          const winner = await tx
            .select()
            .from(documentVersions)
            .where(
              and(
                eq(documentVersions.documentId, documentId),
                eq(documentVersions.version, nextVersion),
              ),
            )
            .limit(1);
          versionId = winner[0].id;
        }
        version = nextVersion;
      }

      for (const chunk of input.chunks) {
        const chunkRows = await tx
          .insert(chunks)
          .values({
            id: uuidv7(),
            documentVersionId: versionId,
            organizationId: orgId,
            sequence: chunk.sequence,
            sourceRange: { byteStart: chunk.byteStart, byteEnd: chunk.byteEnd },
            chunkHash: chunk.chunkHash,
            text: chunk.text,
          })
          .returning({ id: chunks.id });
        await tx.insert(embeddings).values({
          id: uuidv7(),
          chunkId: chunkRows[0].id,
          organizationId: orgId,
          model: input.embeddingModel,
          embedding: chunk.vector,
        });
      }

      await tx
        .update(uploadSessions)
        .set({ state: 'INDEXING', updatedAt: atIso })
        .where(eq(uploadSessions.id, input.sessionId));

      return { documentId, versionId, version };
    });
  }
}
