/**
 * MongoDB `IAssistantKnowledgeQueries` — the assistants module's read-only
 * view over knowledge-domain collections on the mongo lane.
 *
 * Foreign-ownership: `documents`, `chunks`, `embeddings`, `eval_runs`, and
 * `eval_datasets` belong to the knowledge module. This class owns no writes
 * and no schema authority here — it is a read probe only, kept in
 * predicate-for-predicate correspondence with
 * `pg-assistant-knowledge.queries.ts` (same predicates, same `withOrg`
 * session boundary, same caller-visible semantics).
 *
 * Lane conventions: every tenant-scoped access goes through
 * `TenantScopedCollection` (explicit `organization_id` Binary predicates —
 * there is no RLS on this lane). UUIDs are BSON Binary subtype 4
 * (`binUuid`/`uuidOf`); timestamps are ISO-8601 strings, so lexicographic
 * `$lt`/`$gt` comparisons stay correct.
 *
 * Lane note (getChunkEmbeddingStats): the pg adapter's LEFT JOIN fans out
 * when a chunk carries several embeddings for the pinned model —
 * `count(c.id)` counts the chunk row once per joined embedding row. The
 * aggregation below preserves that exact fan-out via `$unwind` with
 * `preserveNullAndEmptyArrays`, so `total`/`embedded` match the pg counts
 * row-for-row on identical data.
 *
 * Lane note (getLatestEvalDecision): pg's `ORDER BY finished_at DESC`
 * places NULLs first; the mongo `$sort` below places missing/null
 * `finished_at` last. Completed eval runs always carry `finished_at`, so
 * the lanes agree on real data.
 */
import { Injectable } from '@nestjs/common';
import type { Binary, Db, Document } from 'mongodb';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency';
import { binUuid, uuidOf } from './mongo-documents';
import type {
  ChunkEmbeddingStats,
  IAssistantKnowledgeQueries,
  LatestEvalDecision,
} from './assistant-knowledge.queries';

interface KnowledgeDocumentDoc extends Document {
  id: Binary;
  state: string;
}

interface ChunkDoc extends Document {
  id: Binary;
  document_version_id: Binary;
}

interface EmbeddingDoc extends Document {
  id: Binary;
  chunk_id: Binary;
  model: string;
}

interface EvalRunDoc extends Document {
  id: Binary;
  decision: string | null;
  score: string | null;
  finished_at: string | null;
}

interface EvalDatasetDoc extends Document {
  id: Binary;
}

@Injectable()
export class MongoAssistantKnowledgeQueries implements IAssistantKnowledgeQueries {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db) {
    return {
      documents: new TenantScopedCollection<KnowledgeDocumentDoc>(
        db.collection<KnowledgeDocumentDoc>('documents'),
      ),
      chunks: new TenantScopedCollection<ChunkDoc>(
        db.collection<ChunkDoc>('chunks'),
      ),
      embeddings: new TenantScopedCollection<EmbeddingDoc>(
        db.collection<EmbeddingDoc>('embeddings'),
      ),
      evalRuns: new TenantScopedCollection<EvalRunDoc>(
        db.collection<EvalRunDoc>('eval_runs'),
      ),
      evalDatasets: new TenantScopedCollection<EvalDatasetDoc>(
        db.collection<EvalDatasetDoc>('eval_datasets'),
      ),
    };
  }

  async getDocumentStates(orgId: string, documentIds: string[]): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    if (documentIds.length === 0) {
      return states;
    }
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const { documents } = this.collections(db);
      const docs = await documents
        .find(
          orgId,
          { id: { $in: documentIds.map((id) => binUuid(id, 'documentId')) } },
          { session: ctx.session, projection: { id: 1, state: 1 } },
        )
        .toArray();
      for (const d of docs) {
        states.set(uuidOf(d.id), d.state);
      }
      return states;
    });
  }

  async getChunkEmbeddingStats(
    orgId: string,
    pairs: Array<{ versionId: string; model: string }>,
  ): Promise<Map<string, ChunkEmbeddingStats>> {
    const byVersion = new Map<string, ChunkEmbeddingStats>();
    if (pairs.length === 0) {
      return byVersion;
    }
    // Per-(version, model) pairs: a version carrying stale rows of ANOTHER
    // model (pre-sweep migration residue) must not inflate its own count.
    // The `want` constant binds each pinned version to exactly its pin's
    // model — the mongo equivalent of the pg adapter's VALUES join.
    const want = pairs.map((pair) => ({
      version_id: binUuid(pair.versionId, 'versionId'),
      model: pair.model,
    }));
    const versionBins = want.map((w) => w.version_id);
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const { chunks } = this.collections(db);
      const rows = await chunks
        .aggregate(
          orgId,
          [
            { $match: { document_version_id: { $in: versionBins } } },
            {
              $addFields: {
                _model: {
                  $let: {
                    vars: { pairs: want },
                    in: {
                      $reduce: {
                        input: '$$pairs',
                        initialValue: null,
                        in: {
                          $cond: [
                            { $eq: ['$$this.version_id', '$document_version_id'] },
                            '$$this.model',
                            '$$value',
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              $lookup: {
                from: 'embeddings',
                let: { cid: '$id', model: '$_model', org: '$organization_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ['$chunk_id', '$$cid'] },
                          { $eq: ['$model', '$$model'] },
                          { $eq: ['$organization_id', '$$org'] },
                        ],
                      },
                    },
                  },
                  { $project: { _id: 0, id: 1 } },
                ],
                as: '_e',
              },
            },
            { $unwind: { path: '$_e', preserveNullAndEmptyArrays: true } },
            {
              $group: {
                _id: '$document_version_id',
                total: { $sum: 1 },
                embedded: { $sum: { $cond: [{ $ne: ['$_e', null] }, 1, 0] } },
              },
            },
          ],
          { session: ctx.session },
        )
        .toArray();
      for (const r of rows as unknown as Array<{ _id: Binary; total: number; embedded: number }>) {
        byVersion.set(uuidOf(r._id), { total: Number(r.total), embedded: Number(r.embedded) });
      }
      return byVersion;
    });
  }

  async getLatestEvalDecision(
    orgId: string,
    versionId: string,
  ): Promise<LatestEvalDecision | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const { evalRuns } = this.collections(db);
      const last = await evalRuns.findOne(
        orgId,
        {
          assistant_version_id: binUuid(versionId, 'versionId'),
          state: 'completed',
          // P5: the version verdict is the FORMAL decision — shadow
          // observations surface via drift alerts, never here.
          is_shadow: false,
        },
        {
          session: ctx.session,
          sort: { finished_at: -1 },
          projection: { decision: 1, score: 1, finished_at: 1 },
        },
      );
      return last?.decision
        ? { decision: last.decision, score: last.score, finished_at: last.finished_at }
        : null;
    });
  }

  async findEvalDatasetId(orgId: string, name: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const { evalDatasets } = this.collections(db);
      const doc = await evalDatasets.findOne(
        orgId,
        { name },
        { session: ctx.session, projection: { id: 1 } },
      );
      return doc ? uuidOf(doc.id) : null;
    });
  }
}
