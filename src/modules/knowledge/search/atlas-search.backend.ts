import type { Document } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { binUuid, ensureKnowledgeIndexes, sessionOf } from '../repositories/mongo-knowledge-shared';
import type { EmbeddingMongoDoc } from '../repositories/mongo-documents';
import { EMBEDDING_DIMENSIONS } from '../schema';
import type {
  ISearchBackend,
  SearchBackendKind,
  SearchVector,
  VectorHit,
  VectorLegQuery,
} from './search-backend';

/**
 * Atlas Vector Search backend (P4) — native `$vectorSearch` on the
 * `embeddings` collection.
 *
 * The vector search index is code-managed, not click-ops: see
 * `atlas-search-indexes.v1.json` (index name `ix_embeddings_vector`,
 * cosine similarity, filter fields `organization_id` / `model` /
 * `chunk_id`). Apply it with the Atlas CLI/API before booting against
 * Atlas. `onBoot` probes the index with a limit-1 `$vectorSearch` — a
 * missing or not-yet-built index aborts boot with an operator-actionable
 * error instead of failing every vector leg at query time (fail-closed;
 * a boot failure while the index builds resolves itself on restart once
 * the build finishes).
 *
 * Authorization posture: `$vectorSearch` cannot join other collections,
 * so this backend REQUIRES `query.candidateChunkIds` — the
 * caller-precomputed admitted chunk set (tenant, ready document, live
 * artifact, ACLs, version pins). The filter constrains the ANN candidate
 * set BEFORE scoring; an absent admitted set throws rather than scanning
 * unfiltered.
 *
 * Index maintenance is a documented no-op: the `embeddings` collection IS
 * the vector index (writes go through the ingestion / re-embed
 * repositories; Atlas maintains the search index itself).
 *
 * Score contract: the index uses cosine similarity, and Atlas's
 * `vectorSearchScore` for cosine is the cosine similarity — the same
 * "higher = more similar" semantics as pgvector `1 - (embedding <=>
 * query)`.
 */
export class AtlasVectorSearchBackend implements ISearchBackend {
  readonly backendKind: SearchBackendKind = 'atlas-vector-search';
  readonly requiresSidecarSync = false;

  /** Name of the code-managed vector search index (atlas-search-indexes.v1.json). */
  static readonly VECTOR_INDEX_NAME = 'ix_embeddings_vector';

  constructor(private readonly mongo: MongoDbService) {}

  /**
   * Fail-closed boot validation: probe the code-managed vector search
   * index with a limit-1 `$vectorSearch`. A missing/misapplied index
   * aborts boot with an operator-actionable error naming the JSON file to
   * apply, instead of failing every vector leg at query time. If the index
   * is still building, boot fails the same way and succeeds on restart
   * once the build finishes — never a silent lexical-only downgrade.
   */
  async onBoot(): Promise<void> {
    const probeVector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    probeVector[0] = 1;
    try {
      await this.mongo.root
        .collection('embeddings')
        .aggregate([
          {
            $vectorSearch: {
              index: AtlasVectorSearchBackend.VECTOR_INDEX_NAME,
              path: 'embedding',
              queryVector: probeVector,
              numCandidates: 10,
              limit: 1,
            },
          },
          { $limit: 1 },
        ])
        .toArray();
    } catch (err) {
      throw new Error(
        `atlas vector search index '${AtlasVectorSearchBackend.VECTOR_INDEX_NAME}' is not queryable: ` +
          `${(err as Error).message}. Apply src/modules/knowledge/search/atlas-search-indexes.v1.json ` +
          'via the Atlas CLI/API and wait for the index to finish building, then restart.',
      );
    }
  }

  async upsertVectors(_input: {
    orgId: string;
    model: string;
    vectors: SearchVector[];
  }): Promise<void> {
    // No-op: the embeddings collection is the index.
  }

  async deleteVectorsForChunks(_input: {
    orgId: string;
    chunkIds: string[];
    model?: string;
  }): Promise<void> {
    // No-op: the embeddings collection is the index.
  }

  async runVectorLeg(query: VectorLegQuery): Promise<VectorHit[]> {
    if (query.vector.length === 0) {
      throw new Error('runVectorLeg: vector must be non-empty');
    }
    if (query.topK <= 0) {
      return [];
    }
    const candidateChunkIds = query.candidateChunkIds;
    if (!candidateChunkIds || candidateChunkIds.length === 0) {
      // Empty admitted set = no hits (fail-closed authorization posture);
      // an ABSENT set is a caller bug and throws.
      if (!candidateChunkIds) {
        throw new Error(
          'runVectorLeg: candidateChunkIds is required for the atlas-vector-search ' +
            'backend — the admitted chunk set must be pre-computed by the caller',
        );
      }
      return [];
    }
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    const chunkBinaries = candidateChunkIds.map((id) => binUuid(id, 'chunkId'));
    const pipeline: Document[] = [
      {
        $vectorSearch: {
          index: AtlasVectorSearchBackend.VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector: query.vector,
          numCandidates: Math.max(query.topK * 10, 100),
          limit: query.topK,
          filter: {
            organization_id: binUuid(query.orgId, 'orgId'),
            model: query.model,
            chunk_id: { $in: chunkBinaries },
          },
        },
      },
      { $project: { _id: 0, chunk_id: 1, score: { $meta: 'vectorSearchScore' } } },
    ];
    return this.mongo.withOrg(query.orgId, async (ctx: MongoTxContext) => {
      const rows: VectorHit[] = [];
      const cursor = db
        .collection<EmbeddingMongoDoc>('embeddings')
        .aggregate<{ chunk_id: { toUUID(): { toString(): string } }; score: number }>(
          pipeline,
          sessionOf(ctx),
        );
      for await (const doc of cursor) {
        rows.push({ chunkId: doc.chunk_id.toUUID().toString(), score: Number(doc.score) });
      }
      return rows;
    });
  }
}
