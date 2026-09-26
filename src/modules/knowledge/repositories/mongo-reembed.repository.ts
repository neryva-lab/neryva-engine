/**
 * MongoDB implementation of the re-embed repository port (P3) — the
 * embedding-model migration worker's persistence.
 *
 * `listReadyOrgIds` is BYPASS (the worker enumerates orgs itself); every
 * other method is tenant-scoped via `mongo.withOrg` + explicit
 * `organization_id` predicates (plan D6).
 */
import type { Db } from 'mongodb';
import { Logger } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { ISearchBackend } from '../search/search-backend';
import { drainSearchIndexOutbox, writeSearchIndexIntents } from '../search/search-index-outbox';
import type {
  ChunkMongoDoc,
  DocumentMongoDoc,
  DocumentVersionMongoDoc,
  EmbeddingMongoDoc,
} from './mongo-documents';
import type { IReEmbedRepository } from './reembed.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  sessionOf,
  toIso,
} from './mongo-knowledge-shared';

const DOCUMENTS = 'documents';
const VERSIONS = 'document_versions';
const CHUNKS = 'chunks';
const EMBEDDINGS = 'embeddings';

export class MongoReEmbedRepository implements IReEmbedRepository {
  private static readonly logger = new Logger(MongoReEmbedRepository.name);

  constructor(
    private readonly mongo: MongoDbService,
    private readonly backend: ISearchBackend,
  ) {}

  async listReadyOrgIds(limit: number): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      // BYPASS: the worker enumerates orgs itself — no tenant context yet.
      // Distinct orgs with ready documents, capped at `limit`.
      const orgIds = await db
        .collection<DocumentMongoDoc>(DOCUMENTS)
        .distinct('organization_id', { state: 'ready' }, sessionOf(ctx));
      return orgIds
        .map((id) => (id as { toUUID(): { toString(): string } }).toUUID().toString())
        .slice(0, Math.max(limit, 0));
    });
  }

  async listPendingDocuments(
    orgId: string,
    effectiveModel: string,
    batch: number,
  ): Promise<Array<{ id: string }>> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const docs = await documents
        .find(
          orgId,
          {
            state: 'ready',
            $or: [{ embedding_model: null }, { embedding_model: { $ne: effectiveModel } }],
          },
          { ...sessionOf(ctx), limit: Math.max(batch, 0), projection: { id: 1 } },
        )
        .toArray();
      return docs.map((d) => ({ id: d.id.toUUID().toString() }));
    });
  }

  async listDocumentChunks(
    orgId: string,
    documentId: string,
  ): Promise<Array<{ chunkId: string; text: string }>> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const chunks = await this.documentChunks(db, ctx, orgId, documentId);
      return chunks.map((c) => ({ chunkId: c.id.toUUID().toString(), text: c.text }));
    });
  }

  /** All chunks of a document (across versions), sequence-ordered. */
  private async documentChunks(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    documentId: string,
  ): Promise<ChunkMongoDoc[]> {
    const versions = new TenantScopedCollection<DocumentVersionMongoDoc>(db.collection(VERSIONS));
    const chunks = new TenantScopedCollection<ChunkMongoDoc>(db.collection(CHUNKS));
    const s = sessionOf(ctx);
    const versionIds = (
      await versions
        .find(orgId, { document_id: binUuid(documentId, 'documentId') }, { ...s, projection: { id: 1 } })
        .toArray()
    ).map((v) => v.id);
    if (versionIds.length === 0) return [];
    return chunks
      .find(orgId, { document_version_id: { $in: versionIds } }, { ...s, sort: { sequence: 1 } })
      .toArray();
  }

  async swapDocumentEmbeddings(input: {
    orgId: string;
    documentId: string;
    targetModel: string;
    vectors: Array<{ chunkId: string; vector: number[] }>;
    at: Date;
  }): Promise<{ chunks: number; staleModelsSwept: number }> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    const orgId = input.orgId;
    const now = toIso(input.at);

    const staged = await this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const embeddings = new TenantScopedCollection<EmbeddingMongoDoc>(db.collection(EMBEDDINGS));
      const s = sessionOf(ctx);

      const chunks = await this.documentChunks(db, ctx, orgId, input.documentId);

      // 1. Insert the target-model embedding rows (pre-computed vectors).
      // uq_embeddings_chunk (chunk_id, model) makes re-inserts idempotent on
      // retry — the atomic upsert is the mongo equivalent of the pg lane's
      // `onConflictDoNothing` (no error is ever raised, so the transaction
      // is never at risk).
      for (const v of input.vectors) {
        const chunkId = binUuid(v.chunkId, 'chunkId');
        await embeddings.updateOne(
          orgId,
          { chunk_id: chunkId, model: input.targetModel },
          {
            $setOnInsert: {
              id: binUuid(newId()),
              organization_id: binUuid(orgId, 'orgId'),
              embedding: v.vector,
            },
          },
          { ...s, upsert: true },
        );
      }

      if (input.vectors.length > 0) {
        // 2. Parity: every chunk of the document must carry a target-model
        // row, or the flip would mark a partially-indexed document
        // complete. Mismatch throws retryable — the document stays pending
        // and converges next tick. (Zero-chunk documents skip straight to
        // the flip: steps 1–2 are vacuous.)
        const chunkIds = chunks.map((c) => c.id);
        const total = chunkIds.length;
        const embedded = await embeddings.countDocuments(
          orgId,
          { chunk_id: { $in: chunkIds }, model: input.targetModel },
          s,
        );
        if (embedded !== total) {
          throw new Error(
            `re-embed parity failed for document ${input.documentId} on ${input.targetModel} (${embedded}/${total} chunks) — retrying next tick`,
          );
        }
      }

      // 3. Pointer flip.
      await documents.updateOne(
        orgId,
        { id: binUuid(input.documentId, 'documentId') },
        { $set: { embedding_model: input.targetModel, updated_at: now } },
        s,
      );

      // 4. Sweep stale-model embedding rows for the document's chunks.
      // `staleModelsSwept` is the DISTINCT stale-model count (matches the
      // pg lane and the worker's log line); the delete sweeps every row of
      // those models.
      const chunkIds = chunks.map((c) => c.id);
      // `distinct` has no tenant-guarded wrapper; the org predicate is
      // explicit here (documented escape hatch).
      const staleModels = await db.collection(EMBEDDINGS).distinct(
        'model',
        {
          organization_id: binUuid(orgId, 'orgId'),
          chunk_id: { $in: chunkIds },
          model: { $ne: input.targetModel },
        },
        s,
      );
      if (staleModels.length > 0) {
        await embeddings.deleteMany(
          orgId,
          { chunk_id: { $in: chunkIds }, model: { $in: staleModels } },
          s,
        );
      }
      // Search-index outbox (P4): durable sync intents in the SAME
      // transaction as the swap — see mongo-ingestion.repository.ts (4b).
      // Stale-model deletes are model-narrowed; the target-model upsert
      // covers the freshly written rows.
      const chunkIdStrings = chunkIds.map((c) => c.toUUID().toString());
      if (this.backend.requiresSidecarSync) {
        await writeSearchIndexIntents(db, s, {
          orgId,
          upserts:
            input.vectors.length > 0
              ? [{ model: input.targetModel, chunkIds: input.vectors.map((v) => v.chunkId) }]
              : [],
          deletes: (staleModels as string[]).map((model) => ({ model, chunkIds: chunkIdStrings })),
        });
      }
      return {
        chunks: input.vectors.length,
        staleModelsSwept: staleModels.length,
        chunkIdStrings,
        staleModels: staleModels as string[],
      };
    });
    // Post-commit search-index sync (P4): drain the outbox intents written
    // in the swap transaction — the fast path. Best effort: a failure is
    // logged and the SearchIndexSyncWorker replays the stranded intents
    // with backoff. Never fails the durable write.
    if (this.backend.requiresSidecarSync) {
      try {
        await drainSearchIndexOutbox(this.mongo, this.backend, { orgId });
      } catch (syncErr) {
        MongoReEmbedRepository.logger.warn(
          `search index sync deferred after re-embed swap for document ${input.documentId}: ` +
            (syncErr as Error).message,
        );
      }
    }
    return { chunks: staged.chunks, staleModelsSwept: staged.staleModelsSwept };
  }
}
