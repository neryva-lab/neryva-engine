import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool, seedOrgChain, TEST_DATABASE_URL } from '../helpers/db';

/**
 * P0 (ai-native-review.md BUG-1) — model-scoped vector search.
 *
 * Corpus design (lexical-hash vectors, so token overlap IS cosine overlap):
 * - query:                    'quasar reactor calibration codes'
 * - chunk A (default model):  'quasar reactor calibration manual draft'  (cos ≈ 0.67)
 * - chunk B (foreign model):  'quasar reactor calibration'               (cos ≈ 0.87)
 * - chunk C (default model):  'codes ledger gamma delta'                 (cos ≈ 0.25)
 * NO chunk contains every query term, so the FTS legs (AND semantics) stay
 * silent — the verdict comes from the vector legs alone (the changed code).
 * Unscoped, B would top outright. Scoped to the default model, B must be
 * entirely absent and A must top. Scoped (via org knowledge_config) to the
 * foreign model, the mirror holds.
 *
 * Memory leg: default-stamped + legacy-NULL rows participate; foreign rows do
 * not — until the org config points at the foreign model.
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  if (!TEST_DATABASE_URL) return false;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const describeIfDb = (await pgReachable()) ? describe : describe.skip;
const FOREIGN_MODEL = 'foreign-model-v9';

describeIfDb('retrieval model scoping (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let embedding: import('../../src/modules/knowledge/embedding.service').EmbeddingService;
  let retrievalDefault: import('../../src/modules/knowledge/retrieval.service').RetrievalService;
  let retrievalForeign: import('../../src/modules/knowledge/retrieval.service').RetrievalService;
  let memory: import('../../src/modules/knowledge/memory.service').MemoryService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const QUERY = 'quasar reactor calibration codes';
  const ids = { chunkA: randomUUID(), chunkB: randomUUID(), chunkC: randomUUID(), doc: randomUUID(), version: randomUUID() };

  const nullConfig = { latest: async () => null };

  beforeAll(async () => {
    await seedOrgChain(pool, orgId);
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    const { RetrievalService } = await import('../../src/modules/knowledge/retrieval.service');
    const { MemoryService } = await import('../../src/modules/knowledge/memory.service');
    const { RerankerService } = await import('../../src/modules/knowledge/reranker.port');
    const { QueryRewriteService } = await import('../../src/modules/knowledge/query-rewrite.port');
    db = new DbService();
    const audit = new AuditService(db);
    embedding = new EmbeddingService();
    // The service's own model label (== EMBEDDING_MODEL) — read off the
    // instance so seed labels can never drift from the query-side default.
    const EMBEDDING_MODEL = embedding.model;
    const reranker = () => new RerankerService();
    const rewrite = () => new QueryRewriteService();
    retrievalDefault = new RetrievalService(db, embedding, reranker(), rewrite(), nullConfig as never);
    retrievalForeign = new RetrievalService(
      db,
      embedding,
      reranker(),
      rewrite(),
      { latest: async () => ({ payload: { embedding_model: FOREIGN_MODEL } }) } as never,
    );
    memory = new MemoryService(db, audit, embedding, nullConfig as never);

    const lit = (vec: number[]) => `[${vec.join(',')}]`;
    const texts = {
      a: 'quasar reactor calibration manual draft',
      b: 'quasar reactor calibration',
      c: 'codes ledger gamma delta',
    };
    const [va, vb, vc] = await embedding.embed([texts.a, texts.b, texts.c]);
    const artifactId = randomUUID();
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`
        insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256, scan_status, state)
        values (${artifactId}::uuid, ${orgId}::uuid, 'SOURCE_DOCUMENT', ${`org/${orgId}/source_document/scoped`}, 'text/plain', 10, ${Buffer.from('s'.repeat(32))}, 'clean', 'active')`);
      await tx.execute(sql`
        insert into documents (id, organization_id, source_artifact_id, source_slug, state, embedding_model, title)
        values (${ids.doc}::uuid, ${orgId}::uuid, ${artifactId}::uuid, 'scoped-doc', 'ready', ${EMBEDDING_MODEL}, 'Scoped doc')`);
      await tx.execute(sql`
        insert into document_versions (id, document_id, organization_id, version, sha256, parser_version)
        values (${ids.version}::uuid, ${ids.doc}::uuid, ${orgId}::uuid, 1, ${Buffer.from('s'.repeat(32))}, 'text-v1')`);
      const chunk = async (id: string, seq: number, text: string) =>
        tx.execute(sql`
          insert into chunks (id, document_version_id, organization_id, sequence, source_range, chunk_hash, text)
          values (${id}::uuid, ${ids.version}::uuid, ${orgId}::uuid, ${seq}, '{"byteStart":0,"byteEnd":10}', ${`h${seq}`.padEnd(64, '0')}, ${text})`);
      await chunk(ids.chunkA, 1, texts.a);
      await chunk(ids.chunkB, 2, texts.b);
      await chunk(ids.chunkC, 3, texts.c);
      const emb = async (chunkId: string, model: string, vec: number[]) =>
        tx.execute(sql`
          insert into embeddings (id, chunk_id, organization_id, model, embedding)
          values (${randomUUID()}::uuid, ${chunkId}::uuid, ${orgId}::uuid, ${model}, ${lit(vec)}::vector)`);
      await emb(ids.chunkA, EMBEDDING_MODEL, va);
      // Contaminant: high cosine to the query, WRONG model, no default-model row.
      await emb(ids.chunkB, FOREIGN_MODEL, vb);
      await emb(ids.chunkC, EMBEDDING_MODEL, vc);
      await tx.execute(sql`
        insert into retrieval_acl (id, organization_id, resource_type, resource_id, visibility)
        values (${randomUUID()}::uuid, ${orgId}::uuid, 'document', ${ids.doc}::uuid, 'organization')`);
    });
  });

  afterAll(async () => {
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  it('excludes cross-model rows from the vector leg (default query model)', async () => {
    const hits = await retrievalDefault.searchKnowledge({ orgId, query: QUERY });
    expect(hits.length).toBeGreaterThan(0);
    // The foreign-model contaminant (cos 0.87, rank 2 unscoped) is gone.
    expect(hits.every((h) => h.chunkId !== ids.chunkB)).toBe(true);
    // Same-model ranking is untouched: the near-exact match tops.
    expect(hits[0].chunkId).toBe(ids.chunkA);
  });

  it('scopes to the org-configured model when knowledge_config sets one', async () => {
    const hits = await retrievalForeign.searchKnowledge({ orgId, query: QUERY });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.chunkId === ids.chunkB)).toBe(true);
  });

  it('scopes the memory leg, keeping legacy NULL rows', async () => {
    const current = await memory.create({ orgId, content: 'quasar reactor calibration codes pledge', scopeType: 'organization', actor });
    // The write path stamps the producing model (service default here — the
    // null-config stub resolves no org model).
    expect(current.embeddingModel).toBe(embedding.model);
    // Legacy (pre-0064, NULL model) + foreign rows, written raw.
    const { sql } = await import('drizzle-orm');
    const [vLegacy, vForeign] = await embedding.embed(['quasar reactor calibration codes legacy note', 'quasar reactor calibration codes foreign note']);
    const lit = (vec: number[]) => `[${vec.join(',')}]`;
    await db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into memory_items (id, organization_id, scope_type, content, embedding, embedding_model)
        values (${randomUUID()}::uuid, ${orgId}::uuid, 'organization', 'quasar reactor calibration codes legacy note', ${lit(vLegacy)}::vector, null)`);
      await tx.execute(sql`
        insert into memory_items (id, organization_id, scope_type, content, embedding, embedding_model)
        values (${randomUUID()}::uuid, ${orgId}::uuid, 'organization', 'quasar reactor calibration codes foreign note', ${lit(vForeign)}::vector, ${FOREIGN_MODEL})`);
    });
    // NOTE: the seed 'seed memory' row (no vector) may join via the recency
    // top-up — assertions target only the three model-labeled rows.
    const scopes = [{ scopeType: 'organization' as const }];
    const foundDefault = await retrievalDefault.searchApprovedMemories({ orgId, query: QUERY, scopes });
    const contentsDefault = foundDefault.map((m) => m.content);
    expect(contentsDefault).toContain('quasar reactor calibration codes pledge');
    expect(contentsDefault).toContain('quasar reactor calibration codes legacy note');
    expect(contentsDefault).not.toContain('quasar reactor calibration codes foreign note');

    const foundForeign = await retrievalForeign.searchApprovedMemories({ orgId, query: QUERY, scopes });
    const contentsForeign = foundForeign.map((m) => m.content);
    expect(contentsForeign).toContain('quasar reactor calibration codes foreign note');
    expect(contentsForeign).toContain('quasar reactor calibration codes legacy note');
    expect(contentsForeign).not.toContain('quasar reactor calibration codes pledge');
  });
});
