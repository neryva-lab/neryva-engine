/**
 * P4 search-backend parity + contract spec.
 *
 * HARD SAFETY RULE: `DATABASE_URL` is pinned to the DEDICATED
 * `neryva_parity` database at module top, before any import that could
 * touch env.ts. Never the live `neryva` DB.
 *
 * Sections:
 *  1. pgvector backend — byte-identical to the CURRENT pg retrieval leg
 *     (`PgRetrievalRepository`, untouched by P4): same chunk order, same
 *     scores, same authorization-before-scoring negatives (cross-org,
 *     private ACL, draft document, model scoping).
 *  2. Atlas backend — contract test against a stubbed MongoDbService (no
 *     live Atlas in CI): pipeline shape, score mapping, admitted-set
 *     enforcement, fail-closed on missing candidateChunkIds.
 *  3. Qdrant backend — contract test against an in-process HTTP mock that
 *     implements the Qdrant REST surface with REAL cosine scoring:
 *     onBoot collection management, upsert/search/delete round-trips,
 *     tenant isolation, admitted-set enforcement, recall@k == brute force.
 *  4. Cross-backend recall@k agreement on one synthetic corpus
 *     (pgvector vs Qdrant mock): identical top-k ORDER. Documented
 *     tolerance: exact agreement on well-separated similarities; in
 *     production ANN indexes may reorder near-ties, which RRF (rank-based)
 *     tolerates.
 */
// ═══════════════════════════════════════════════════════════════════════════
// HARD SAFETY RULE — pin before any env-touching import.
// ═══════════════════════════════════════════════════════════════════════════
process.env.DATABASE_URL =
  'postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva_parity';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { Binary } from 'mongodb';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import { PgVectorSearchBackend } from './pgvector-search.backend';
import { AtlasVectorSearchBackend } from './atlas-search.backend';
import { QdrantSearchBackend, probeQdrant } from './qdrant-search.backend';
import { resolveSearchBackendKind } from './search-backend';
import { PgRetrievalRepository } from '../repositories/pg-retrieval.repository';

const DATABASE_URL = process.env.DATABASE_URL;
const MODEL = 'test-model';
const DIMS = 1536;

// ---------------------------------------------------------------------------
// synthetic vectors: sparse, well-separated cosine similarities
// ---------------------------------------------------------------------------
function vec(entries: Record<number, number>): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, x] of Object.entries(entries)) v[Number(i)] = x;
  return v;
}
const QUERY = vec({ 0: 1 });
const V = {
  // NOTE: cosine is scale-invariant — single-component vectors are all
  // parallel to the query. The second component below makes the intended
  // similarities exact.
  c1: vec({ 0: 1, 1: 0.1 }), // cos ≈ 0.9950
  c6: vec({ 0: 0.95, 1: 0.312241808 }), // cos = 0.95 (private doc)
  c5: vec({ 0: 0.9, 1: 0.435889894 }), // cos = 0.9
  c4: vec({ 0: 0.5, 1: 0.5 }), // cos ≈ 0.7071
  c2: vec({ 1: 1 }), // cos = 0
  c3: vec({ 0: -1 }), // cos = -1
};
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const vecLiteral = (v: number[]): string => `[${v.join(',')}]`;

// ---------------------------------------------------------------------------
// pg fixture DDL — IDENTICAL shapes to the P3 knowledge parity spec's
// PG_TABLES for every shared table (both specs share `neryva_parity` and
// use CREATE TABLE IF NOT EXISTS, so the shapes must agree).
// ---------------------------------------------------------------------------
const PG_TABLES = [
  `CREATE TABLE IF NOT EXISTS "artifacts" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "purpose" varchar(32) NOT NULL,
     "object_key" varchar(512) NOT NULL,
     "content_type_declared" varchar(128) NOT NULL,
     "content_type_detected" varchar(128),
     "byte_length" bigint NOT NULL,
     "sha256" bytea NOT NULL,
     "encryption_key_ref" varchar(128),
     "scan_status" varchar(32) NOT NULL DEFAULT 'pending',
     "state" varchar(32) NOT NULL DEFAULT 'active',
     "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
     "expires_at" timestamptz,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "documents" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "source_artifact_id" uuid NOT NULL,
     "title" varchar(256),
     "state" varchar(32) NOT NULL DEFAULT 'processing',
     "source_slug" varchar(64) NOT NULL,
     "embedding_model" varchar(64),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_documents_org_slug" UNIQUE ("organization_id", "source_slug"),
     CONSTRAINT "uq_documents_source_artifact" UNIQUE ("source_artifact_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "document_versions" (
     "id" uuid PRIMARY KEY,
     "document_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "version" integer NOT NULL,
     "sha256" bytea NOT NULL,
     "parser_version" varchar(32) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_document_versions_doc_version" UNIQUE ("document_id", "version")
   )`,
  `CREATE TABLE IF NOT EXISTS "chunks" (
     "id" uuid PRIMARY KEY,
     "document_version_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "sequence" integer NOT NULL,
     "source_range" jsonb NOT NULL,
     "chunk_hash" varchar(64) NOT NULL,
     "text" varchar(8192) NOT NULL,
     "fts" tsvector
   )`,
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE TABLE IF NOT EXISTS "embeddings" (
     "id" uuid PRIMARY KEY,
     "chunk_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "model" varchar(64) NOT NULL,
     "embedding" vector(1536) NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS "retrieval_acl" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "resource_type" varchar(32) NOT NULL DEFAULT 'document',
     "resource_id" uuid NOT NULL,
     "visibility" varchar(32) NOT NULL DEFAULT 'organization',
     "scope_account_id" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "document_source_acls" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "document_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_document_source_acls" UNIQUE ("document_id", "provider", "external_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "external_identity_links" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "account_id" uuid NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_external_identity_links" UNIQUE ("organization_id", "provider", "external_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "external_principals" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "kind" varchar(16) NOT NULL,
     "email" varchar(320),
     "display" varchar(256),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_external_principals_org_provider_external" UNIQUE ("organization_id", "provider", "external_id")
   )`,
];

async function pgReachable(): Promise<boolean> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// section 1: pgvector backend vs the current pg retrieval leg
// ---------------------------------------------------------------------------
describe('pgvector backend — byte-identical to the pg retrieval leg', () => {
  let backend: PgVectorSearchBackend | undefined;
  let repo: PgRetrievalRepository | undefined;
  // chunk ids by key
  const ids: Record<string, string> = {};
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();
  const ACCT_X = randomUUID();

  async function q(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    // max:1 pool = one connection; the P3 parity spec force-enables RLS on
    // these tables, so fixtures run with the engine bypass (the same
    // setting DbService.withBypass uses). The vector-leg SQL under test
    // still carries its own explicit organization_id predicates — RLS is
    // not what scopes the compared results.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query(`SET app.engine_bypass = 'on'`);
        const r = await client.query(text, params as never[]);
        return r.rows as Array<Record<string, unknown>>;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    if (!(await pgReachable())) return;
    const { DbService } = await import('../../../common/infra/db/db.service');
    const db = new DbService();
    backend = new PgVectorSearchBackend(db as never);
    repo = new PgRetrievalRepository(db as never);

    const setup = drizzle(new Pool({ connectionString: DATABASE_URL, max: 2 }));
    for (const ddl of PG_TABLES) await setup.execute(sql.raw(ddl));

    // fixture: org A — one org-visible doc (5 chunks), one private doc,
    // one draft doc; org B — one doc (cross-org negative).
    const insertDoc = async (
      orgId: string,
      opts: { state?: string; visibility?: string; scopeAccountId?: string | null } = {},
    ) => {
      const artifactId = randomUUID();
      const docId = randomUUID();
      const versionId = randomUUID();
      await q(
        `insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256, state, scan_status)
         values ($1::uuid, $2::uuid, 'document', 'doc', 'text/plain', 128, '\\x00', 'active', 'clean')`,
        [artifactId, orgId],
      );
      await q(
        `insert into documents (id, organization_id, source_artifact_id, state, source_slug)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
        [docId, orgId, artifactId, opts.state ?? 'ready', `slug-${docId.slice(0, 8)}`],
      );
      await q(
        `insert into document_versions (id, document_id, organization_id, version, sha256, parser_version)
         values ($1::uuid, $2::uuid, $3::uuid, 1, '\\x00', 'v1')`,
        [versionId, docId, orgId],
      );
      await q(
        `insert into retrieval_acl (id, organization_id, resource_id, visibility, scope_account_id)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
        [randomUUID(), orgId, docId, opts.visibility ?? 'organization', opts.scopeAccountId ?? null],
      );
      return { docId, versionId };
    };
    const insertChunk = async (orgId: string, versionId: string, key: string, vector: number[], model = MODEL) => {
      const chunkId = randomUUID();
      ids[key] = chunkId;
      await q(
        `insert into chunks (id, document_version_id, organization_id, sequence, text, source_range, chunk_hash)
         values ($1::uuid, $2::uuid, $3::uuid, 0, 'x', '{"start":0,"end":1}', 'h')`,
        [chunkId, versionId, orgId],
      );
      await q(
        `insert into embeddings (id, chunk_id, organization_id, model, embedding)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5::vector)`,
        [randomUUID(), chunkId, orgId, model, vecLiteral(vector)],
      );
    };

    const d1 = await insertDoc(ORG_A);
    for (const key of ['c1', 'c5', 'c4', 'c2', 'c3'] as const) {
      await insertChunk(ORG_A, d1.versionId, key, V[key]);
    }
    // model-scoping negative: c1 also embedded under another model — must
    // never leak into test-model legs.
    await insertChunk(ORG_A, d1.versionId, 'c1-other-model', V.c3, 'other-model');

    const d2 = await insertDoc(ORG_A, { visibility: 'private', scopeAccountId: ACCT_X });
    await insertChunk(ORG_A, d2.versionId, 'c6', V.c6);

    const d3 = await insertDoc(ORG_A, { state: 'processing' });
    await insertChunk(ORG_A, d3.versionId, 'c7', V.c1);

    const dB = await insertDoc(ORG_B);
    await insertChunk(ORG_B, dB.versionId, 'c8', V.c1);
  }, 60_000);

  const legInput = (overrides: Record<string, unknown> = {}) => ({
    orgId: ORG_A,
    vectorLegs: [{ vectorLiteral: vecLiteral(QUERY), pool: 10, queryModel: MODEL }],
    ftsLegs: [],
    versionIds: null,
    accountId: null,
    callerAccountId: null,
    callerEmails: [],
    ...overrides,
  });

  it('returns the identical chunk order and scores as the current pg leg', async () => {
    if (!backend || !repo) return; // pg unreachable — suite skips
    const hits = await backend.runVectorLeg({
      orgId: ORG_A,
      vector: QUERY,
      model: MODEL,
      topK: 10,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: Object.values(ids),
    });
    const legs = await repo.runRetrievalLegs(legInput());
    const rows = legs.vectorLegs[0] as Array<{ chunk_id: string; score: number }>;

    // same admitted set, same order
    expect(hits.map((h) => h.chunkId)).toEqual(rows.map((r) => String(r.chunk_id)));
    // byte-identical scores (same SQL text, same rows)
    for (let i = 0; i < hits.length; i++) {
      expect(hits[i].score).toBeCloseTo(Number(rows[i].score), 12);
    }
    // expected ranking from the synthetic similarities
    expect(hits.map((h) => h.chunkId)).toEqual([ids.c1, ids.c5, ids.c4, ids.c2, ids.c3]);
    // scores ARE the cosine similarities (pgvector `1 - (embedding <=> query)`)
    expect(hits[0].score).toBeCloseTo(cosine(QUERY, V.c1), 6);
    expect(hits[4].score).toBeCloseTo(-1, 6);
  });

  it('excludes cross-org, private-ACL, draft, and other-model rows', async () => {
    if (!backend || !repo) return;
    const hits = await backend.runVectorLeg({
      orgId: ORG_A,
      vector: QUERY,
      model: MODEL,
      topK: 10,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: Object.values(ids),
    });
    const got = new Set(hits.map((h) => h.chunkId));
    expect(got.has(ids.c8)).toBe(false); // org B
    expect(got.has(ids.c6)).toBe(false); // private to ACCT_X
    expect(got.has(ids.c7)).toBe(false); // draft document
    expect(got.has(ids['c1-other-model'])).toBe(false); // wrong model
    // and the repository agrees on every exclusion
    const rows = (await repo.runRetrievalLegs(legInput())).vectorLegs[0] as Array<{ chunk_id: string }>;
    const repoGot = new Set(rows.map((r) => String(r.chunk_id)));
    expect([...got].sort()).toEqual([...repoGot].sort());
  });

  it('admits the private document for its scoped account — backend and leg agree', async () => {
    if (!backend || !repo) return;
    const query = {
      orgId: ORG_A,
      vector: QUERY,
      model: MODEL,
      topK: 10,
      versionIds: null,
      accountId: ACCT_X,
      callerAccountId: null as string | null,
      callerEmails: [],
      candidateChunkIds: Object.values(ids),
    };
    const hits = await backend.runVectorLeg(query);
    const rows = (await repo.runRetrievalLegs(legInput({ accountId: ACCT_X }))).vectorLegs[0] as Array<{
      chunk_id: string;
      score: number;
    }>;
    expect(hits.map((h) => h.chunkId)).toEqual(rows.map((r) => String(r.chunk_id)));
    // c6 (cos 0.95) ranks between c1 and c5
    expect(hits.map((h) => h.chunkId)).toEqual([ids.c1, ids.c6, ids.c5, ids.c4, ids.c2, ids.c3]);
  });
});

// ---------------------------------------------------------------------------
// section 2: Atlas backend contract (stubbed MongoDbService — no live Atlas)
// ---------------------------------------------------------------------------
describe('atlas backend contract', () => {
  // minimal fake of the MongoDbService surface the backend touches
  const captured: { pipeline: Array<Record<string, unknown>> | null } = { pipeline: null };
  const cannedDocs = [
    { chunk_id: { toUUID: () => ({ toString: () => 'chunk-1' }) }, score: 0.91 },
    { chunk_id: { toUUID: () => ({ toString: () => 'chunk-2' }) }, score: 0.42 },
  ];
  const fakeMongo = {
    root: {
      collection: () => ({
        createIndex: async () => 'idx',
        aggregate: (pipeline: Array<Record<string, unknown>>) => {
          captured.pipeline = pipeline;
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const d of cannedDocs) yield d;
            },
          };
        },
      }),
    },
    withOrg: async <T>(_orgId: string, fn: (ctx: unknown) => Promise<T>): Promise<T> => fn({}),
  };

  it('issues $vectorSearch against the code-managed index with an authorization pre-filter', async () => {
    const backend = new AtlasVectorSearchBackend(fakeMongo as never);
    const orgId = randomUUID();
    const chunkA = randomUUID();
    const chunkB = randomUUID();
    const hits = await backend.runVectorLeg({
      orgId,
      vector: QUERY,
      model: MODEL,
      topK: 5,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: [chunkA, chunkB],
    });
    expect(hits).toEqual([
      { chunkId: 'chunk-1', score: 0.91 },
      { chunkId: 'chunk-2', score: 0.42 },
    ]);
    const stage = captured.pipeline?.[0]?.['$vectorSearch'] as Record<string, unknown>;
    expect(stage.index).toBe(AtlasVectorSearchBackend.VECTOR_INDEX_NAME);
    expect(stage.queryVector).toEqual(QUERY);
    expect(stage.limit).toBe(5);
    const filter = stage.filter as Record<string, unknown>;
    expect(filter.model).toBe(MODEL);
    expect(filter.organization_id).toBeInstanceOf(Binary);
    expect((filter.chunk_id as { $in: unknown[] }).$in).toHaveLength(2);
    const project = captured.pipeline?.[1]?.['$project'] as Record<string, unknown>;
    expect((project.score as { $meta: string }).$meta).toBe('vectorSearchScore');
  });

  it('fails closed when the admitted chunk set is absent; empty set yields no hits', async () => {
    const backend = new AtlasVectorSearchBackend(fakeMongo as never);
    await expect(
      backend.runVectorLeg({
        orgId: randomUUID(),
        vector: QUERY,
        model: MODEL,
        topK: 5,
        versionIds: null,
        accountId: null,
        callerAccountId: null,
        callerEmails: [],
      }),
    ).rejects.toThrow(/candidateChunkIds is required/);
    await expect(
      backend.runVectorLeg({
        orgId: randomUUID(),
        vector: QUERY,
        model: MODEL,
        topK: 5,
        versionIds: null,
        accountId: null,
        callerAccountId: null,
        callerEmails: [],
        candidateChunkIds: [],
      }),
    ).resolves.toEqual([]);
  });

  it('index maintenance is a documented no-op (the collection IS the index)', async () => {
    const backend = new AtlasVectorSearchBackend(fakeMongo as never);
    await expect(
      backend.upsertVectors({ orgId: randomUUID(), model: MODEL, vectors: [] }),
    ).resolves.toBeUndefined();
    await expect(
      backend.deleteVectorsForChunks({ orgId: randomUUID(), chunkIds: [randomUUID()] }),
    ).resolves.toBeUndefined();
  });

  it('onBoot probes the code-managed index; a missing index fails closed with operator guidance', async () => {
    const probed: Array<Array<Record<string, unknown>>> = [];
    const okMongo = {
      root: {
        collection: () => ({
          aggregate: (pipeline: Array<Record<string, unknown>>) => {
            probed.push(pipeline);
            return { toArray: async () => [] };
          },
        }),
      },
    };
    await expect(new AtlasVectorSearchBackend(okMongo as never).onBoot()).resolves.toBeUndefined();
    const stage = probed[0]?.[0]?.['$vectorSearch'] as Record<string, unknown>;
    expect(stage.index).toBe(AtlasVectorSearchBackend.VECTOR_INDEX_NAME);
    expect(stage.limit).toBe(1);
    expect((stage.queryVector as number[]).length).toBe(1536);

    const missingMongo = {
      root: {
        collection: () => ({
          aggregate: () => ({
            toArray: async () => {
              throw new Error('index ix_embeddings_vector not found');
            },
          }),
        }),
      },
    };
    await expect(new AtlasVectorSearchBackend(missingMongo as never).onBoot()).rejects.toThrow(
      /atlas-search-indexes\.v1\.json/,
    );
  });
});

// ---------------------------------------------------------------------------
// section 3: Qdrant backend contract (in-process HTTP mock, real cosine)
// ---------------------------------------------------------------------------
interface MockPoint {
  vector: number[];
  payload: { org_id: string; model: string; chunk_id: string };
}
interface MockCollection {
  size: number;
  points: Map<string, MockPoint>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : null;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function matchesFilter(
  payload: Record<string, string>,
  filter: { must?: Array<{ key: string; match: { value?: string; any?: string[] } }> },
): boolean {
  for (const clause of filter.must ?? []) {
    const actual = payload[clause.key];
    if (clause.match.value !== undefined) {
      if (actual !== clause.match.value) return false;
    } else if (clause.match.any !== undefined) {
      if (!clause.match.any.includes(actual)) return false;
    }
  }
  return true;
}

describe('qdrant backend contract', () => {
  let server: Server;
  let baseUrl: string;
  const collections = new Map<string, MockCollection>();

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const parts = url.pathname.split('/').filter(Boolean);
        if (req.method === 'GET' && parts.length === 0) {
          send(res, 200, { title: 'qdrant-mock', version: '1.0.0' });
          return;
        }
        if (parts[0] === 'collections' && parts.length >= 2) {
          const name = parts[1];
          const col = collections.get(name);
          if (req.method === 'GET' && parts.length === 2) {
            if (!col) {
              send(res, 404, { status: { error: `collection ${name} not found` } });
              return;
            }
            send(res, 200, {
              result: { config: { params: { vectors: { size: col.size, distance: 'Cosine' } } } },
              status: 'ok',
            });
            return;
          }
          if (req.method === 'PUT' && parts.length === 2) {
            const body = (await readJson(req)) as { vectors: { size: number } };
            collections.set(name, { size: body.vectors.size, points: new Map() });
            send(res, 200, { result: true, status: 'ok' });
            return;
          }
          if (!col) {
            send(res, 404, { status: { error: `collection ${name} not found` } });
            return;
          }
          if (req.method === 'PUT' && parts[2] === 'points') {
            const body = (await readJson(req)) as { points: Array<{ id: string; vector: number[]; payload: MockPoint['payload'] }> };
            for (const p of body.points) col.points.set(p.id, { vector: p.vector, payload: p.payload });
            send(res, 200, { result: { operation_id: 1, status: 'completed' }, status: 'ok' });
            return;
          }
          if (req.method === 'POST' && parts[2] === 'points' && parts[3] === 'delete') {
            const body = (await readJson(req)) as { filter: Parameters<typeof matchesFilter>[1] };
            let deleted = 0;
            for (const [id, p] of col.points) {
              if (matchesFilter(p.payload as unknown as Record<string, string>, body.filter)) {
                col.points.delete(id);
                deleted += 1;
              }
            }
            send(res, 200, { result: { deleted }, status: 'ok' });
            return;
          }
          if (req.method === 'POST' && parts[2] === 'points' && parts[3] === 'search') {
            const body = (await readJson(req)) as {
              vector: number[];
              limit: number;
              filter: Parameters<typeof matchesFilter>[1];
            };
            const scored: Array<{ id: string; score: number; payload: { chunk_id: string } }> = [];
            for (const [id, p] of col.points) {
              if (!matchesFilter(p.payload as unknown as Record<string, string>, body.filter)) continue;
              scored.push({ id, score: cosine(body.vector, p.vector), payload: { chunk_id: p.payload.chunk_id } });
            }
            scored.sort((a, b) => b.score - a.score);
            send(res, 200, { result: scored.slice(0, body.limit), status: 'ok' });
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
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  const Q_ORG = 'q-org-a';
  const chunkKeys = ['c1', 'c5', 'c4', 'c2', 'c3', 'c6'] as const;

  async function seed(backend: QdrantSearchBackend): Promise<void> {
    await backend.onBoot();
    await backend.upsertVectors({
      orgId: Q_ORG,
      model: MODEL,
      vectors: chunkKeys.map((k) => ({ chunkId: `q-${k}`, vector: V[k] })),
    });
    // cross-tenant decoy with an identical vector — must never leak
    await backend.upsertVectors({
      orgId: 'q-org-b',
      model: MODEL,
      vectors: [{ chunkId: 'q-decoy', vector: V.c1 }],
    });
  }

  it('probe succeeds against a live endpoint; onBoot creates the collection idempotently', async () => {
    expect(await probeQdrant(baseUrl)).toEqual({ ok: true });
    const backend = new QdrantSearchBackend(baseUrl);
    await backend.onBoot();
    expect(collections.get(QdrantSearchBackend.COLLECTION)?.size).toBe(DIMS);
    await backend.onBoot(); // idempotent
  });

  it('recall@k matches brute-force cosine exactly on the same corpus', async () => {
    const backend = new QdrantSearchBackend(baseUrl);
    await seed(backend);
    const admitted = chunkKeys.map((k) => `q-${k}`);
    const hits = await backend.runVectorLeg({
      orgId: Q_ORG,
      vector: QUERY,
      model: MODEL,
      topK: 6,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: admitted,
    });
    const brute = chunkKeys
      .map((k) => ({ chunkId: `q-${k}`, score: cosine(QUERY, V[k]) }))
      .sort((a, b) => b.score - a.score);
    expect(hits.map((h) => h.chunkId)).toEqual(brute.map((b) => b.chunkId));
    for (let i = 0; i < hits.length; i++) {
      expect(hits[i].score).toBeCloseTo(brute[i].score, 9);
    }
    // topK honored
    const top3 = await backend.runVectorLeg({
      orgId: Q_ORG,
      vector: QUERY,
      model: MODEL,
      topK: 3,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: admitted,
    });
    expect(top3.map((h) => h.chunkId)).toEqual(brute.slice(0, 3).map((b) => b.chunkId));
  });

  it('enforces tenant isolation and the admitted chunk set', async () => {
    const backend = new QdrantSearchBackend(baseUrl);
    await seed(backend);
    // tenant filter: q-org-b sees only its decoy
    const other = await backend.runVectorLeg({
      orgId: 'q-org-b',
      vector: QUERY,
      model: MODEL,
      topK: 6,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: ['q-decoy'],
    });
    expect(other.map((h) => h.chunkId)).toEqual(['q-decoy']);
    // admitted-set filter: subset of chunks
    const subset = await backend.runVectorLeg({
      orgId: Q_ORG,
      vector: QUERY,
      model: MODEL,
      topK: 6,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: ['q-c2', 'q-c3'],
    });
    expect(subset.map((h) => h.chunkId).sort()).toEqual(['q-c2', 'q-c3']);
    // absent admitted set fails closed
    await expect(
      backend.runVectorLeg({
        orgId: Q_ORG,
        vector: QUERY,
        model: MODEL,
        topK: 6,
        versionIds: null,
        accountId: null,
        callerAccountId: null,
        callerEmails: [],
      }),
    ).rejects.toThrow(/candidateChunkIds is required/);
  });

  it('deletes vectors for chunks', async () => {
    const backend = new QdrantSearchBackend(baseUrl);
    await seed(backend);
    await backend.deleteVectorsForChunks({ orgId: Q_ORG, chunkIds: ['q-c1', 'q-c5'] });
    const hits = await backend.runVectorLeg({
      orgId: Q_ORG,
      vector: QUERY,
      model: MODEL,
      topK: 6,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: chunkKeys.map((k) => `q-${k}`),
    });
    const got = new Set(hits.map((h) => h.chunkId));
    expect(got.has('q-c1')).toBe(false);
    expect(got.has('q-c5')).toBe(false);
    expect(got.has('q-c4')).toBe(true);
    // re-seed for the other tests (deterministic point ids converge)
    await seed(backend);
  });

  it('rejects dimension mismatches loudly', async () => {
    const backend = new QdrantSearchBackend(baseUrl);
    await backend.onBoot();
    await expect(
      backend.upsertVectors({
        orgId: Q_ORG,
        model: MODEL,
        vectors: [{ chunkId: 'q-bad', vector: new Array(DIMS - 1).fill(0) }],
      }),
    ).rejects.toThrow(/1535.*1536|dimensions/);
    await expect(
      backend.runVectorLeg({
        orgId: Q_ORG,
        vector: new Array(DIMS - 1).fill(0),
        model: MODEL,
        topK: 3,
        versionIds: null,
        accountId: null,
        callerAccountId: null,
        callerEmails: [],
        candidateChunkIds: ['q-c1'],
      }),
    ).rejects.toThrow(/dimensions/);
  });

  it('onBoot refuses a wrong-shaped existing collection', async () => {
    // create the collection with a wrong size directly, bypassing onBoot
    const res = await fetch(`${baseUrl}/collections/${QdrantSearchBackend.COLLECTION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vectors: { size: 768, distance: 'Cosine' } }),
    });
    expect(res.ok).toBe(true);
    const backend = new QdrantSearchBackend(baseUrl);
    await expect(backend.onBoot()).rejects.toThrow(/vector size 768/);
    // restore the correctly-shaped collection for the remaining tests
    collections.delete(QdrantSearchBackend.COLLECTION);
    await backend.onBoot();
    await seed(backend);
  });

  it('fail-closed: unreachable QDRANT_URL resolves to a boot error naming the URL', async () => {
    const deadUrl = 'http://127.0.0.1:1'; // nothing listens here
    const probe = await probeQdrant(deadUrl);
    expect(probe.ok).toBe(false);
    expect(() =>
      resolveSearchBackendKind({
        dbProvider: 'mongodb',
        mongoUri: 'mongodb://localhost:27017/neryva',
        qdrantUrl: deadUrl,
        qdrantReachable: probe.ok,
        qdrantProbeError: probe.error,
      }),
    ).toThrow(/http:\/\/127\.0\.0\.1:1.*unreachable/);
  });
});

// ---------------------------------------------------------------------------
// section 4: cross-backend recall@k agreement (same corpus, pg vs qdrant)
// ---------------------------------------------------------------------------
// Documented tolerance: on this synthetic corpus (well-separated cosine
// similarities) the two backends must agree EXACTLY on top-k order — both
// score exact cosine similarity. In production, ANN indexes (Atlas HNSW,
// Qdrant HNSW) may reorder near-ties; that is tolerated because the
// service fuses legs with RRF, which consumes ranks, not scores.
describe('cross-backend recall@k agreement', () => {
  let pgBackend: PgVectorSearchBackend | null = null;
  let qdrant: QdrantSearchBackend;
  let server: Server;
  let baseUrl: string;
  const collections = new Map<string, MockCollection>();
  const ORG = randomUUID();
  const keyByChunk = new Map<string, string>();

  beforeAll(async () => {
    // qdrant mock (same implementation as section 3)
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && parts.length === 0) {
        send(res, 200, { title: 'qdrant-mock', version: '1.0.0' });
        return;
      }
      if (parts[0] === 'collections' && parts[1]) {
        const name = parts[1];
        const col = collections.get(name);
        if (req.method === 'GET' && parts.length === 2) {
          if (!col) return send(res, 404, { status: { error: 'not found' } });
          return send(res, 200, {
            result: { config: { params: { vectors: { size: col.size, distance: 'Cosine' } } } },
            status: 'ok',
          });
        }
        if (req.method === 'PUT' && parts.length === 2) {
          const body = (await readJson(req)) as { vectors: { size: number } };
          collections.set(name, { size: body.vectors.size, points: new Map() });
          return send(res, 200, { result: true, status: 'ok' });
        }
        if (!col) return send(res, 404, { status: { error: 'not found' } });
        if (req.method === 'PUT' && parts[2] === 'points') {
          const body = (await readJson(req)) as { points: Array<{ id: string; vector: number[]; payload: MockPoint['payload'] }> };
          for (const p of body.points) col.points.set(p.id, { vector: p.vector, payload: p.payload });
          return send(res, 200, { result: { operation_id: 1, status: 'completed' }, status: 'ok' });
        }
        if (req.method === 'POST' && parts[2] === 'points' && parts[3] === 'search') {
          const body = (await readJson(req)) as {
            vector: number[];
            limit: number;
            filter: Parameters<typeof matchesFilter>[1];
          };
          const scored: Array<{ id: string; score: number; payload: { chunk_id: string } }> = [];
          for (const [id, p] of col.points) {
            if (!matchesFilter(p.payload as unknown as Record<string, string>, body.filter)) continue;
            scored.push({ id, score: cosine(body.vector, p.vector), payload: { chunk_id: p.payload.chunk_id } });
          }
          scored.sort((a, b) => b.score - a.score);
          return send(res, 200, { result: scored.slice(0, body.limit), status: 'ok' });
        }
      }
      send(res, 404, { status: { error: 'unknown route' } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('mock failed to bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    qdrant = new QdrantSearchBackend(baseUrl);
    await qdrant.onBoot();

    if (!(await pgReachable())) return;
    const { DbService } = await import('../../../common/infra/db/db.service');
    const db = new DbService();
    pgBackend = new PgVectorSearchBackend(db as never);

    // pg corpus: same 5 vectors as chunk ids x-c1..x-c5
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const setup = drizzle(pool);
    // RLS bypass for the raw fixture writes (see the `q` helper above).
    const bypassClient = await pool.connect();
    const pq = async (text: string, params: unknown[] = []): Promise<void> => {
      await bypassClient.query(text, params as never[]);
    };
    try {
      await bypassClient.query(`SET app.engine_bypass = 'on'`);
      for (const ddl of PG_TABLES) await setup.execute(sql.raw(ddl));
      const artifactId = randomUUID();
      const docId = randomUUID();
      const versionId = randomUUID();
      await pq(
        `insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256, state, scan_status)
         values ($1::uuid, $2::uuid, 'document', 'doc', 'text/plain', 128, '\\x00', 'active', 'clean')`,
        [artifactId, ORG],
      );
      await pq(
        `insert into documents (id, organization_id, source_artifact_id, state, source_slug)
         values ($1::uuid, $2::uuid, $3::uuid, 'ready', $4)`,
        [docId, ORG, artifactId, `x-${docId.slice(0, 8)}`],
      );
      await pq(
        `insert into document_versions (id, document_id, organization_id, version, sha256, parser_version)
         values ($1::uuid, $2::uuid, $3::uuid, 1, '\\x00', 'v1')`,
        [versionId, docId, ORG],
      );
      await pq(
        `insert into retrieval_acl (id, organization_id, resource_id, visibility)
         values ($1::uuid, $2::uuid, $3::uuid, 'organization')`,
        [randomUUID(), ORG, docId],
      );
      for (const key of ['c1', 'c5', 'c4', 'c2', 'c3'] as const) {
        const chunkId = randomUUID();
        keyByChunk.set(chunkId, key);
        await pq(
          `insert into chunks (id, document_version_id, organization_id, sequence, text, source_range, chunk_hash)
           values ($1::uuid, $2::uuid, $3::uuid, 0, 'x', '{"start":0,"end":1}', 'h')`,
          [chunkId, versionId, ORG],
        );
        await pq(
          `insert into embeddings (id, chunk_id, organization_id, model, embedding)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5::vector)`,
          [randomUUID(), chunkId, ORG, MODEL, vecLiteral(V[key])],
        );
        // mirror into qdrant under the SAME chunk id
        await qdrant.upsertVectors({ orgId: ORG, model: MODEL, vectors: [{ chunkId: chunkId, vector: V[key] }] });
      }
    } finally {
      bypassClient.release();
      await pool.end();
    }
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('pgvector and qdrant return the identical top-k order', async () => {
    if (!pgBackend) return; // pg unreachable — skips
    const pgHits = await pgBackend.runVectorLeg({
      orgId: ORG,
      vector: QUERY,
      model: MODEL,
      topK: 5,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: [],
    });
    const admitted = pgHits.map((h) => h.chunkId);
    const qHits = await qdrant.runVectorLeg({
      orgId: ORG,
      vector: QUERY,
      model: MODEL,
      topK: 5,
      versionIds: null,
      accountId: null,
      callerAccountId: null,
      callerEmails: [],
      candidateChunkIds: admitted,
    });
    expect(qHits.map((h) => h.chunkId)).toEqual(admitted);
    // the agreed order is the true similarity ranking on the corpus
    expect(admitted.map((id) => keyByChunk.get(id))).toEqual(['c1', 'c5', 'c4', 'c2', 'c3']);
  });
});
