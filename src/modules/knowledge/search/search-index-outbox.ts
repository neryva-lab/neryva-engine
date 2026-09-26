import { Logger } from '@nestjs/common';
import { Binary, ObjectId, type ClientSession, type Db } from 'mongodb';
import { binUuid } from '../repositories/mongo-knowledge-shared';
import type { ISearchBackend } from './search-backend';

/**
 * Search-index outbox (P4) — replay-safe sidecar indexing for backends that
 * keep a vector index OUTSIDE the canonical store (Qdrant).
 *
 * The problem: Qdrant is an external HTTP service — it cannot join the
 * MongoDB transaction that writes the canonical `embeddings` rows. A
 * post-commit best-effort HTTP call is not replay-safe: a crash or a Qdrant
 * outage between the commit and the sync silently loses vectors, and the
 * loss only heals if something happens to rewrite those exact chunks.
 *
 * The design (canonical transaction + outbox + sweeper):
 * 1. Repositories write sync INTENTS into `search_index_outbox` in the SAME
 *    MongoDB transaction as the canonical embedding writes. The intent is
 *    durable exactly when the data is — no window for silent loss, and no
 *    weakening of the canonical transaction's atomicity (one extra insert
 *    in the same TX).
 * 2. Intents name chunk IDs, not vectors. The drainer re-reads the CURRENT
 *    canonical vectors at drain time, so replay always converges on the
 *    latest state (a re-embed that lands between intent and drain is picked
 *    up, not clobbered).
 * 3. Drain claims intents with an atomic `findOneAndDelete` (FIFO by `_id`
 *    — chunk-ID lifecycles are linear, so FIFO preserves per-chunk order),
 *    applies them to the backend, and re-queues with exponential backoff
 *    on failure. Intents are NEVER dropped on failure: the sweeper replays
 *    them until they apply.
 * 4. Two drain triggers: an inline post-commit drain in the repositories
 *    (fast path — new vectors are searchable immediately when Qdrant is
 *    healthy) and the `SearchIndexSyncWorker` sweeper (replays anything
 *    stranded by a crash or an outage).
 *
 * Only backends with `requiresSidecarSync === true` produce or consume
 * intents. pgvector/Atlas index the canonical store directly, so their
 * repositories write nothing and the drainer is a no-op.
 */

export const SEARCH_INDEX_OUTBOX = 'search_index_outbox';

/** Sync op: `upsert` re-indexes the chunks' current vectors; `delete` drops them. */
export type SearchIndexOp = 'upsert' | 'delete';

export interface SearchIndexIntent {
  _id: ObjectId;
  /** Tenant scope — every drain filters on it. */
  organization_id: Binary;
  op: SearchIndexOp;
  /**
   * Embedding model for `upsert` (vector-space correctness) and for
   * model-narrowed `delete` (re-embed stale-model sweep). `null` on `delete`
   * = all models for the chunks (re-chunk / document delete).
   */
  model: string | null;
  chunk_ids: Binary[];
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
}

export interface SearchIndexIntentInput {
  orgId: string;
  upserts: Array<{ model: string; chunkIds: string[] }>;
  deletes: Array<{ model: string | null; chunkIds: string[] }>;
}

const logger = new Logger('SearchIndexOutbox');

/** Idempotent: safe to call on every boot / before every drain. */
export async function ensureSearchIndexOutboxIndexes(db: Db): Promise<void> {
  await db
    .collection(SEARCH_INDEX_OUTBOX)
    .createIndex({ organization_id: 1, next_attempt_at: 1 }, { name: 'ix_search_outbox_org_due' })
    .catch(() => undefined);
}

/**
 * Record sync intents. MUST be called inside the canonical transaction
 * (`session` from `sessionOf(ctx)`) — durability of the intent is then tied
 * to durability of the embedding writes by the transaction itself.
 */
export async function writeSearchIndexIntents(
  db: Db,
  session: { session?: ClientSession },
  input: SearchIndexIntentInput,
): Promise<void> {
  const orgBin = binUuid(input.orgId, 'orgId');
  const now = new Date();
  const docs: Array<Omit<SearchIndexIntent, '_id'>> = [];
  for (const u of input.upserts) {
    if (u.chunkIds.length === 0) continue;
    docs.push({
      organization_id: orgBin,
      op: 'upsert',
      model: u.model,
      chunk_ids: u.chunkIds.map((id) => binUuid(id, 'chunkId')),
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
    });
  }
  for (const d of input.deletes) {
    if (d.chunkIds.length === 0) continue;
    docs.push({
      organization_id: orgBin,
      op: 'delete',
      model: d.model,
      chunk_ids: d.chunkIds.map((id) => binUuid(id, 'chunkId')),
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
    });
  }
  if (docs.length === 0) return;
  await db.collection(SEARCH_INDEX_OUTBOX).insertMany(docs, session);
}

/** Backoff between drain attempts: 5s, 10s, 20s … capped at 5 minutes. */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export interface DrainResult {
  claimed: number;
  applied: number;
  failed: number;
}

/**
 * Drain due intents (FIFO). Atomic `findOneAndDelete` claims each intent —
 * two drainers can never apply the same intent twice. On failure the intent
 * is re-queued with backoff, never dropped.
 */
export async function drainSearchIndexOutbox(
  mongo: { root: Db },
  backend: ISearchBackend,
  opts: { orgId?: string; limit?: number; now?: Date } = {},
): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, applied: 0, failed: 0 };
  if (!backend.requiresSidecarSync) return result;
  const db = mongo.root;
  await ensureSearchIndexOutboxIndexes(db);
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;
  const coll = db.collection<SearchIndexIntent>(SEARCH_INDEX_OUTBOX);

  for (let i = 0; i < limit; i += 1) {
    const intent = await coll.findOneAndDelete(
      {
        next_attempt_at: { $lte: now },
        ...(opts.orgId ? { organization_id: binUuid(opts.orgId, 'orgId') } : {}),
      },
      { sort: { _id: 1 } },
    );
    if (!intent) break;
    result.claimed += 1;
    try {
      await applyIntent(db, backend, intent);
      result.applied += 1;
    } catch (err) {
      result.failed += 1;
      const attempts = (intent.attempts ?? 0) + 1;
      await coll.insertOne({
        _id: intent._id,
        organization_id: intent.organization_id,
        op: intent.op,
        model: intent.model,
        chunk_ids: intent.chunk_ids,
        attempts,
        next_attempt_at: new Date(now.getTime() + outboxBackoffMs(attempts)),
        created_at: intent.created_at ?? now,
      });
      logger.warn(
        `search index intent ${intent._id.toHexString()} (${intent.op}) failed ` +
          `(attempt ${attempts}) — re-queued: ${(err as Error).message}`,
      );
    }
  }
  return result;
}

async function applyIntent(db: Db, backend: ISearchBackend, intent: SearchIndexIntent): Promise<void> {
  const orgId = intent.organization_id.toUUID().toString();
  const chunkIds = intent.chunk_ids.map((b) => b.toUUID().toString());
  if (chunkIds.length === 0) return;
  if (intent.op === 'delete') {
    await backend.deleteVectorsForChunks({
      orgId,
      chunkIds,
      model: intent.model ?? undefined,
    });
    return;
  }
  // Upsert: re-read the CURRENT canonical vectors (convergent — a re-embed
  // that landed after the intent was written is picked up, not clobbered).
  // Chunks deleted from the canonical store since are skipped: their removal
  // is covered by the corresponding delete intent.
  if (!intent.model) return;
  const rows = await db
    .collection('embeddings')
    .find({
      organization_id: intent.organization_id,
      model: intent.model,
      chunk_id: { $in: intent.chunk_ids },
    })
    .toArray();
  if (rows.length === 0) return;
  await backend.upsertVectors({
    orgId,
    model: intent.model,
    vectors: rows.map((r) => ({
      chunkId: (r.chunk_id as Binary).toUUID().toString(),
      vector: r.embedding as number[],
    })),
  });
}
