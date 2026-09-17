import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool, seedOrgChain, buildAssistantsService, TEST_DATABASE_URL } from '../helpers/db';

/**
 * P0 (ai-native-review.md GAP-1) — embedding coverage publish gate.
 *
 * A READY document whose pinned version is only PARTIALLY embedded for the
 * active model scores nothing at retrieval — shipping it is silent context
 * loss, the same class as an unresolved slug. Publish refuses (422,
 * `knowledge_pins`, naming the slug with embedded/total counts) unless the
 * caller explicitly acknowledges degraded knowledge (audited, with the
 * undercovered pins named in the audit details).
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

describeIfDb('publish embedding-coverage gate (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let model: string;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const docId = randomUUID();
  const versionId = randomUUID();
  const chunkIds = [randomUUID(), randomUUID()];

  const draftPayload = (sources: string[]) => ({
    instructions: 'You are a test agent answering from pinned knowledge.',
    model_policy: { allowed_models: ['test/model'] },
    context_policy: { knowledge_sources: sources },
    tool_policy: { tools: [] },
    guardrail_policy: {},
  });

  beforeAll(async () => {
    await seedOrgChain(pool, orgId);
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    db = new DbService();
    assistants = await buildAssistantsService(db);
    const embedding = new EmbeddingService();
    model = embedding.model;

    const artifactId = randomUUID();
    const [v1, v2] = await embedding.embed(['gated document first half alfa', 'gated document second half beta']);
    const lit = (vec: number[]) => `[${vec.join(',')}]`;
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`
        insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256, scan_status, state)
        values (${artifactId}::uuid, ${orgId}::uuid, 'SOURCE_DOCUMENT', ${`org/${orgId}/source_document/gated`}, 'text/plain', 10, ${Buffer.from('s'.repeat(32))}, 'clean', 'active')`);
      await tx.execute(sql`
        insert into documents (id, organization_id, source_artifact_id, source_slug, state, embedding_model, title)
        values (${docId}::uuid, ${orgId}::uuid, ${artifactId}::uuid, 'gated-doc', 'ready', ${model}, 'Gated doc')`);
      await tx.execute(sql`
        insert into document_versions (id, document_id, organization_id, version, sha256, parser_version)
        values (${versionId}::uuid, ${docId}::uuid, ${orgId}::uuid, 1, ${Buffer.from('s'.repeat(32))}, 'text-v1')`);
      await tx.execute(sql`
        insert into chunks (id, document_version_id, organization_id, sequence, source_range, chunk_hash, text)
        values (${chunkIds[0]}::uuid, ${versionId}::uuid, ${orgId}::uuid, 1, '{"byteStart":0,"byteEnd":10}', ${'g1'.padEnd(64, '0')}, 'gated document first half alfa')`);
      await tx.execute(sql`
        insert into chunks (id, document_version_id, organization_id, sequence, source_range, chunk_hash, text)
        values (${chunkIds[1]}::uuid, ${versionId}::uuid, ${orgId}::uuid, 2, '{"byteStart":10,"byteEnd":20}', ${'g2'.padEnd(64, '0')}, 'gated document second half beta')`);
      // Only the FIRST chunk is embedded — 1/2 coverage.
      await tx.execute(sql`
        insert into embeddings (id, chunk_id, organization_id, model, embedding)
        values (${randomUUID()}::uuid, ${chunkIds[0]}::uuid, ${orgId}::uuid, ${model}, ${lit(v1)}::vector)`);
      void v2;
    });
  });

  afterAll(async () => {
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  async function createDraftedAssistant(name: string) {
    const created = await assistants.create({ orgId, name, createdBy: actor });
    const version = await assistants.createVersion({
      orgId,
      assistantId: created.assistant.id,
      payload: draftPayload(['gated-doc']) as never,
      createdBy: actor,
    });
    return { assistantId: created.assistant.id, versionId: version.id };
  }

  it('refuses to publish a partially-indexed pin, naming slug + counts', async () => {
    const { assistantId, versionId: draftId } = await createDraftedAssistant(`gated-${randomUUID().slice(0, 8)}`);
    await expect(assistants.publish({ orgId, assistantId, versionId: draftId, publishedBy: actor })).rejects.toMatchObject({
      code: 'validation_failed',
      details: { knowledge_pins: expect.stringContaining('gated-doc') },
    });
    await expect(assistants.publish({ orgId, assistantId, versionId: draftId, publishedBy: actor })).rejects.toMatchObject({
      details: { knowledge_pins: expect.stringContaining('1/2') },
    });
  });

  it('publishes once coverage completes, and the snapshot records it', async () => {
    const { sql } = await import('drizzle-orm');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    const [v2] = await new EmbeddingService().embed(['gated document second half beta']);
    await db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into embeddings (id, chunk_id, organization_id, model, embedding)
        values (${randomUUID()}::uuid, ${chunkIds[1]}::uuid, ${orgId}::uuid, ${model}, ${`[${v2.join(',')}]`}::vector)`);
    });
    const { assistantId, versionId: draftId } = await createDraftedAssistant(`whole-${randomUUID().slice(0, 8)}`);
    const published = await assistants.publish({ orgId, assistantId, versionId: draftId, publishedBy: actor });
    expect(published.status).toBe('PUBLISHED');
    const snapshot = await assistants.getSnapshotForVersion(orgId, assistantId, published.id);
    const pins = (snapshot?.knowledgePins ?? []) as Array<{ source_slug: string; embedding_coverage: { complete: boolean } | null }>;
    expect(pins.find((p) => p.source_slug === 'gated-doc')?.embedding_coverage?.complete).toBe(true);
  });

  it('acknowledged degraded publish succeeds and audits the waived pins', async () => {
    // Remove the second chunk embedding again → back to 1/2.
    const { sql } = await import('drizzle-orm');
    await db.withBypass(async (tx) => {
      await tx.execute(sql`delete from embeddings where chunk_id = ${chunkIds[1]}::uuid`);
    });
    const { assistantId, versionId: draftId } = await createDraftedAssistant(`acked-${randomUUID().slice(0, 8)}`);
    const published = await assistants.publish({ orgId, assistantId, versionId: draftId, publishedBy: actor, acknowledgeDegradedKnowledge: true });
    expect(published.status).toBe('PUBLISHED');
    const rows = await db.withOrg(orgId, async (tx) =>
      tx.execute(sql`select details from audit_events where tenant_id = ${orgId} and action = 'assistant.publish_degraded_acknowledged' order by created_at desc limit 1`),
    );
    const raw = (rows.rows[0] as { details: unknown }).details;
    // Raw sql().execute returns jsonb unparsed (text) on this path — parse it.
    const details = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { undercovered_pins: string[] };
    expect(details.undercovered_pins.some((p) => p.includes('gated-doc') && p.includes('1/2'))).toBe(true);
  });
});
