/**
 * Search-index outbox spec (P4) — replay-safe sidecar indexing.
 *
 * Covers:
 * 1. `writeSearchIndexIntents` is transactional: abort → no intents,
 *    commit → intents present.
 * 2. Drain success: canonical embeddings → Qdrant points, outbox empty.
 * 3. Drain failure is replay-safe: the intent survives with backoff, is not
 *    due until the backoff elapses, then applies once Qdrant is healthy.
 * 4. Delete intents remove points; model-narrowed deletes only that model.
 * 5. Upsert intents for chunks missing from the canonical store are skipped
 *    cleanly (no crash, no phantom points).
 * 6. `requiresSidecarSync === false` → drain is a no-op.
 * 7. Repository integration: `MongoIngestionRepository.indexDocumentVersion`
 *    against a DEAD Qdrant still commits (durable write never fails) and
 *    leaves intents; a later drain syncs the vectors.
 *
 * Pins `neryva_parity` only for the DATABASE_URL-shaped constants it
 * imports — this spec uses mongodb-memory-server, never live Mongo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Binary, Db, MongoClient } from 'mongodb';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { QdrantSearchBackend } from './qdrant-search.backend';
import {
  SEARCH_INDEX_OUTBOX,
  drainSearchIndexOutbox,
  outboxBackoffMs,
  writeSearchIndexIntents,
  type SearchIndexIntent,
} from './search-index-outbox';
import type { ISearchBackend } from './search-backend';

// ---------------------------------------------------------------------------
// minimal mock Qdrant (collections + points, with a fail switch)
// ---------------------------------------------------------------------------
interface MockPoint {
  vector: number[];
  payload: Record<string, string>;
}

let failMode = false;
const points = new Map<string, MockPoint>();
let server: Server;
let baseUrl = '';

function send(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const COLLECTION = QdrantSearchBackend.COLLECTION;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      if (failMode) {
        send(res, 500, { status: { error: 'injected failure' } });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'collections' && parts[1] === COLLECTION) {
        if (req.method === 'GET' && parts.length === 2) {
          send(res, 200, {
            result: { config: { params: { vectors: { size: 1536, distance: 'Cosine' } } } },
            status: 'ok',
          });
          return;
        }
        if (req.method === 'PUT' && parts.length === 2) {
          send(res, 200, { result: true, status: 'ok' });
          return;
        }
        if (req.method === 'PUT' && parts[2] === 'points') {
          const body = (await readJson(req)) as {
            points: Array<{ id: string; vector: number[]; payload: Record<string, string> }>;
          };
          for (const p of body.points) points.set(p.id, { vector: p.vector, payload: p.payload });
          send(res, 200, { result: { operation_id: 1, status: 'completed' }, status: 'ok' });
          return;
        }
        if (req.method === 'POST' && parts[2] === 'points' && parts[3] === 'delete') {
          const body = (await readJson(req)) as {
            filter: { must: Array<{ key: string; match: { value?: string; any?: string[] } }> };
          };
          const must = body.filter?.must ?? [];
          const matches = (payload: Record<string, string>): boolean =>
            must.every((c) => {
              const v = payload[c.key];
              if (c.match.value !== undefined) return v === c.match.value;
              if (c.match.any !== undefined) return c.match.any.includes(v);
              return false;
            });
          let deleted = 0;
          for (const [id, p] of points) {
            if (matches(p.payload)) {
              points.delete(id);
              deleted += 1;
            }
          }
          send(res, 200, { result: { deleted }, status: 'ok' });
          return;
        }
      }
      send(res, 404, { status: { error: 'unknown route' } });
    } catch (err) {
      send(res, 500, { status: { error: (err as Error).message } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock failed to bind');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// ---------------------------------------------------------------------------
// mongo harness (memory replset, disk-backed TMPDIR)
// ---------------------------------------------------------------------------
let replSet: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

const ORG = randomUUID();
const MODEL = 'test-model';
const DIMS = 1536;

/** 1536-dim vector with the given [index, value] entries nonzero. */
function vec(...nz: Array<[number, number]>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, x] of nz) v[i] = x;
  return v;
}

function binUuid(id: string): Binary {
  return new Binary(Buffer.from(id.replace(/-/g, ''), 'hex'), 4);
}

async function seedEmbedding(chunkId: string, model: string, vector: number[]): Promise<void> {
  await db.collection('embeddings').insertOne({
    id: binUuid(randomUUID()),
    chunk_id: binUuid(chunkId),
    organization_id: binUuid(ORG),
    model,
    embedding: vector,
  });
}

async function outboxCount(): Promise<number> {
  return db.collection(SEARCH_INDEX_OUTBOX).countDocuments();
}

async function readIntents(): Promise<SearchIndexIntent[]> {
  return db.collection<SearchIndexIntent>(SEARCH_INDEX_OUTBOX).find({}).toArray();
}

beforeAll(async () => {
  const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-search-outbox-${process.pid}`;
  await rm(dbPath, { recursive: true, force: true });
  await mkdir(dbPath, { recursive: true });
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath }],
  });
  client = new MongoClient(replSet.getUri());
  await client.connect();
  db = client.db('neryva_search_outbox');
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  await replSet.stop().catch(() => undefined);
});

describe('search index outbox', () => {
  // Isolation: every test starts with an empty outbox, empty mock Qdrant,
  // and no canonical embeddings — a failed drain must never leak intents
  // into the next test.
  beforeEach(async () => {
    await db.collection(SEARCH_INDEX_OUTBOX).deleteMany({});
    await db.collection('embeddings').deleteMany({});
    points.clear();
    failMode = false;
  });

  it('intent writes are transactional: abort drops them, commit keeps them', async () => {
    const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
    const session = client.startSession();
    try {
      await runInTransaction(session, async () => {
        await writeSearchIndexIntents(
          db,
          { session },
          { orgId: ORG, upserts: [{ model: MODEL, chunkIds: [randomUUID()] }], deletes: [] },
        );
        throw new Error('boom');
      }).catch(() => undefined);
      expect(await outboxCount()).toBe(0);

      const session2 = client.startSession();
      try {
        await runInTransaction(session2, async () => {
          await writeSearchIndexIntents(
            db,
            { session: session2 },
            { orgId: ORG, upserts: [{ model: MODEL, chunkIds: [randomUUID()] }], deletes: [] },
          );
        });
      } finally {
        await session2.endSession().catch(() => undefined);
      }
      expect(await outboxCount()).toBe(1);
    } finally {
      await session.endSession().catch(() => undefined);
    }
  });

  it('drain applies upsert intents from the canonical store, then empties the outbox', async () => {
    const c1 = randomUUID();
    const c2 = randomUUID();
    await seedEmbedding(c1, MODEL, vec([0, 1]));
    await seedEmbedding(c2, MODEL, vec([1, 1]));
    await writeSearchIndexIntents(
      db,
      {},
      { orgId: ORG, upserts: [{ model: MODEL, chunkIds: [c1, c2] }], deletes: [] },
    );

    const backend = new QdrantSearchBackend(baseUrl);
    const result = await drainSearchIndexOutbox({ root: db }, backend);
    expect(result).toEqual({ claimed: 1, applied: 1, failed: 0 });
    expect(await outboxCount()).toBe(0);
    expect(points.get(QdrantSearchBackend.pointId(c1, MODEL))?.vector).toEqual(vec([0, 1]));
    expect(points.get(QdrantSearchBackend.pointId(c2, MODEL))?.vector).toEqual(vec([1, 1]));
  });

  it('drain failure is replay-safe: intent survives with backoff, applies when Qdrant recovers', async () => {
    const c1 = randomUUID();
    await seedEmbedding(c1, MODEL, vec([2, 1]));
    await writeSearchIndexIntents(
      db,
      {},
      { orgId: ORG, upserts: [{ model: MODEL, chunkIds: [c1] }], deletes: [] },
    );

    failMode = true;
    const backend = new QdrantSearchBackend(baseUrl);
    try {
      const r1 = await drainSearchIndexOutbox({ root: db }, backend);
      expect(r1).toEqual({ claimed: 1, applied: 0, failed: 1 });
      // intent survives, attempts=1, not due until the backoff elapses
      const intents = await readIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].attempts).toBe(1);
      expect(intents[0].next_attempt_at.getTime()).toBeGreaterThan(Date.now());
      expect(outboxBackoffMs(1)).toBe(5_000);

      // immediate re-drain claims nothing (backoff not elapsed)
      const r2 = await drainSearchIndexOutbox({ root: db }, backend);
      expect(r2).toEqual({ claimed: 0, applied: 0, failed: 0 });

      // after the backoff elapses and Qdrant recovers, replay applies it
      failMode = false;
      const r3 = await drainSearchIndexOutbox({ root: db }, backend, {
        now: new Date(Date.now() + 60_000),
      });
      expect(r3).toEqual({ claimed: 1, applied: 1, failed: 0 });
      expect(await outboxCount()).toBe(0);
      expect(points.get(QdrantSearchBackend.pointId(c1, MODEL))?.vector).toEqual(vec([2, 1]));
    } finally {
      failMode = false;
    }
  });

  it('delete intents remove points; model-narrowed deletes only that model', async () => {
    const c1 = randomUUID();
    const backend = new QdrantSearchBackend(baseUrl);
    await backend.upsertVectors({
      orgId: ORG,
      model: MODEL,
      vectors: [{ chunkId: c1, vector: vec([3, 1]) }],
    });
    await backend.upsertVectors({
      orgId: ORG,
      model: 'other-model',
      vectors: [{ chunkId: c1, vector: vec([3, 1]) }],
    });
    expect(points.has(QdrantSearchBackend.pointId(c1, MODEL))).toBe(true);

    await writeSearchIndexIntents(
      db,
      {},
      { orgId: ORG, upserts: [], deletes: [{ model: MODEL, chunkIds: [c1] }] },
    );
    const result = await drainSearchIndexOutbox({ root: db }, backend);
    expect(result).toEqual({ claimed: 1, applied: 1, failed: 0 });
    expect(points.has(QdrantSearchBackend.pointId(c1, MODEL))).toBe(false);
    // other model's point survives the narrowed delete
    expect(points.has(QdrantSearchBackend.pointId(c1, 'other-model'))).toBe(true);

    // un-narrowed delete (model: null) removes every model for the chunks
    await writeSearchIndexIntents(
      db,
      {},
      { orgId: ORG, upserts: [], deletes: [{ model: null, chunkIds: [c1] }] },
    );
    await drainSearchIndexOutbox({ root: db }, backend);
    expect(points.has(QdrantSearchBackend.pointId(c1, 'other-model'))).toBe(false);
  });

  it('upsert intents for chunks missing from the canonical store are skipped cleanly', async () => {
    const ghost = randomUUID();
    await writeSearchIndexIntents(
      db,
      {},
      { orgId: ORG, upserts: [{ model: MODEL, chunkIds: [ghost] }], deletes: [] },
    );
    const before = points.size;
    const backend = new QdrantSearchBackend(baseUrl);
    const result = await drainSearchIndexOutbox({ root: db }, backend);
    expect(result).toEqual({ claimed: 1, applied: 1, failed: 0 });
    expect(points.size).toBe(before);
    expect(points.has(QdrantSearchBackend.pointId(ghost, MODEL))).toBe(false);
  });

  it('drain is a no-op when the backend does not require sidecar sync', async () => {
    await writeSearchIndexIntents(
      db,
      {},
      { orgId: ORG, upserts: [{ model: MODEL, chunkIds: [randomUUID()] }], deletes: [] },
    );
    const noSidecar: ISearchBackend = {
      backendKind: 'pgvector',
      requiresSidecarSync: false,
      upsertVectors: async () => {},
      deleteVectorsForChunks: async () => {},
      runVectorLeg: async () => [],
    };
    const result = await drainSearchIndexOutbox({ root: db }, noSidecar);
    expect(result).toEqual({ claimed: 0, applied: 0, failed: 0 });
    // the intent is untouched — a non-sidecar backend never owns the outbox
    expect(await outboxCount()).toBe(1);
    await db.collection(SEARCH_INDEX_OUTBOX).deleteMany({});
  });

  it('org scoping: a drain for org A never claims org B intents', async () => {
    const orgB = randomUUID();
    const cB = randomUUID();
    await db.collection('embeddings').insertOne({
      id: binUuid(randomUUID()),
      chunk_id: binUuid(cB),
      organization_id: binUuid(orgB),
      model: MODEL,
      embedding: vec([4, 1]),
    });
    await writeSearchIndexIntents(
      db,
      {},
      { orgId: orgB, upserts: [{ model: MODEL, chunkIds: [cB] }], deletes: [] },
    );
    const backend = new QdrantSearchBackend(baseUrl);
    const result = await drainSearchIndexOutbox({ root: db }, backend, { orgId: ORG });
    expect(result).toEqual({ claimed: 0, applied: 0, failed: 0 });
    expect(await outboxCount()).toBe(1);
    const full = await drainSearchIndexOutbox({ root: db }, backend);
    expect(full.claimed).toBe(1);
    expect(await outboxCount()).toBe(0);
  });

  it('ingestion against a dead Qdrant commits and leaves replayable intents', async () => {
    const { MongoIngestionRepository } = await import('../repositories/mongo-ingestion.repository');
    const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
    const { ensureKnowledgeIndexes } = await import('../repositories/mongo-knowledge-shared');
    await ensureKnowledgeIndexes(db);

    const mongoFake = {
      root: db,
      withOrg: async <T>(
        orgId: string,
        fn: (ctx: { session: never; orgId: string | null }) => Promise<T>,
      ): Promise<T> => {
        const session = client.startSession();
        try {
          return await runInTransaction(session, () => fn({ session: session as never, orgId }));
        } finally {
          await session.endSession().catch(() => undefined);
        }
      },
    };
    // Dead Qdrant: nothing listens on port 1 — every sync HTTP call fails.
    const deadBackend = new QdrantSearchBackend('http://127.0.0.1:1');
    expect(deadBackend.requiresSidecarSync).toBe(true);
    const repo = new MongoIngestionRepository(mongoFake as never, deadBackend);

    const org = randomUUID();
    const chunkVector = vec([5, 0.5], [6, 0.25]);
    // The durable write MUST NOT fail even though the sidecar is down.
    const indexed = await repo.indexDocumentVersion({
      orgId: org,
      sessionId: randomUUID(),
      artifactId: randomUUID(),
      targetDocumentId: null,
      sourceSlug: `outbox-dead-${randomUUID().slice(0, 8)}`,
      title: 'Outbox Dead-Qdrant Doc',
      connectorRef: null,
      contentSha256: new Uint8Array(32),
      parserVersion: 'v1',
      embeddingModel: MODEL,
      chunks: [
        {
          sequence: 0,
          byteStart: 0,
          byteEnd: 10,
          chunkHash: 'deadhash',
          text: 'dead qdrant chunk',
          vector: chunkVector,
        },
      ],
      at: new Date(),
    });
    expect(indexed.documentId).toBeTruthy();

    // The canonical embedding row is durable …
    const embCount = await db.collection('embeddings').countDocuments({
      organization_id: binUuid(org),
      model: MODEL,
    });
    expect(embCount).toBe(1);
    // … and exactly one upsert intent is stranded in the outbox …
    const intents = await db
      .collection<SearchIndexIntent>(SEARCH_INDEX_OUTBOX)
      .find({ organization_id: binUuid(org) })
      .toArray();
    expect(intents).toHaveLength(1);
    expect(intents[0].op).toBe('upsert');
    expect(intents[0].model).toBe(MODEL);

    // … which replays cleanly once Qdrant is healthy. (The repo's inline
    // post-commit drain already attempted it against the dead Qdrant and
    // backed off, so replay with an advanced clock.)
    const liveBackend = new QdrantSearchBackend(baseUrl);
    const drained = await drainSearchIndexOutbox({ root: db }, liveBackend, {
      orgId: org,
      now: new Date(Date.now() + 60_000),
    });
    expect(drained).toEqual({ claimed: 1, applied: 1, failed: 0 });
    expect(
      await db
        .collection(SEARCH_INDEX_OUTBOX)
        .countDocuments({ organization_id: binUuid(org) }),
    ).toBe(0);
    const chunkId = (
      await db.collection('embeddings').findOne({ organization_id: binUuid(org), model: MODEL })
    )?.chunk_id as Binary;
    const chunkIdStr = chunkId.toUUID().toString();
    expect(points.get(QdrantSearchBackend.pointId(chunkIdStr, MODEL))?.vector).toEqual(chunkVector);
  });
});
