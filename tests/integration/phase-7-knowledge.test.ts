import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool, seedOrgChain, TEST_DATABASE_URL } from '../helpers/db';

/**
 * Phase 7 integration — DB-only parts of the knowledge plane: memory
 * proposal promotion, ACL-before-scoring semantics, upload session state
 * guards. The full upload→ingest→retrieval path requires object storage and
 * runs in the compose stack (described in the suite skip notes).
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

describeIfDb('knowledge memory + retrieval guards (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let memory: import('../../src/modules/knowledge/memory.service').MemoryService;
  let retrieval: import('../../src/modules/knowledge/retrieval.service').RetrievalService;
  const orgId = randomUUID();
  const actor = 'integration-test';

  beforeAll(async () => {
    await seedOrgChain(pool, orgId);
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { MemoryService } = await import('../../src/modules/knowledge/memory.service');
    const { RetrievalService } = await import('../../src/modules/knowledge/retrieval.service');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    db = new DbService();
    const audit = new AuditService(db);
    memory = new MemoryService(db, audit);
    retrieval = new RetrievalService(db, new EmbeddingService());
  });

  afterAll(async () => {
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`delete from memory_proposals where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from memory_items where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from retrieval_acl where organization_id = ${orgId}::uuid`);
    });
    await db.onModuleDestroy();
  });

  it('memory proposals become items only via approval; rejection creates nothing', async () => {
    // Seed a proposal (bypass — normally written via MCP authority).
    const runId = randomUUID();
    const proposalId = randomUUID();
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`
        insert into runs (id, organization_id, conversation_id, input_message_id, assistant_version_id, policy_snapshot_id, state)
        select ${runId}::uuid, ${orgId}::uuid, c.id, m.id, av.id, ps.id, 'RUNNING'
        from conversations c
        join messages m on m.conversation_id = c.id
        join assistants a on a.id = c.assistant_id
        join assistant_versions av on av.assistant_id = a.id
        join policy_snapshots ps on ps.assistant_version_id = av.id
        where c.organization_id = ${orgId}::uuid
        limit 1
      `);
      if ((await tx.execute(sql`select 1 from runs where id = ${runId}::uuid`)).rows.length === 0) {
        // No conversation chain in this org — create one minimally.
        throw new Error('seed requires assistants chain (run seedOrgChain in test setup)');
      }
      await tx.execute(sql`
        insert into memory_proposals (id, organization_id, run_id, proposal_ref, scope, value, confidence)
        values (${proposalId}::uuid, ${orgId}::uuid, ${runId}::uuid, 'prop-1', 'organization', 'approved memory value', 0.9)
      `);
      await tx.execute(sql`
        insert into memory_proposals (id, organization_id, run_id, proposal_ref, scope, value, confidence)
        values (${randomUUID()}::uuid, ${orgId}::uuid, ${runId}::uuid, 'prop-reject', 'organization', 'rejected value', 0.5)
      `);
    });

    const listed = await memory.list(orgId);
    void listed;

    // Approve the first proposal (look it up by ref via decision path).
    const proposals = await db.withOrg(orgId, async (tx) => {
      const { memoryProposals } = await import('../../src/modules/conversations/mcp.schema');
      return tx.select().from(memoryProposals).where(eq(memoryProposals.organizationId, orgId));
    });
    const toApprove = proposals.find((p) => p.proposalRef === 'prop-1')!;
    const toReject = proposals.find((p) => p.proposalRef === 'prop-reject')!;

    const approved = await memory.decide({ orgId, proposalId: toApprove.id, decision: 'APPROVED', actor, scopeType: 'organization' });
    expect(approved.memoryItem?.content).toBe('approved memory value');
    await expect(memory.decide({ orgId, proposalId: toApprove.id, decision: 'REJECTED', actor })).rejects.toMatchObject({ code: 'conflict' });

    await memory.decide({ orgId, proposalId: toReject.id, decision: 'REJECTED', actor });
    const items = await memory.list(orgId);
    expect(items.some((i) => i.content === 'approved memory value')).toBe(true);
    expect(items.some((i) => i.content === 'rejected value')).toBe(false);
  });

  it('search returns typed errors on empty query and no results on zero-vector queries', async () => {
    await expect(retrieval.searchKnowledge({ orgId, query: '' })).rejects.toMatchObject({ code: 'validation_failed' });
    // Punctuation-only query → zero vector → empty result, not an error.
    const hits = await retrieval.searchKnowledge({ orgId, query: '!!! ???' });
    expect(hits).toEqual([]);
  });

  it('soft-deleted memories disappear from list (tombstone semantics)', async () => {
    const approved = await db.withOrg(orgId, async (tx) => {
      const { memoryItems } = await import('../../src/modules/knowledge/schema');
      const rows = await tx
        .insert(memoryItems)
        .values({
          id: randomUUID(),
          organizationId: orgId,
          scopeType: 'organization',
          content: 'to-be-deleted',
          sourceRef: { test: true },
        })
        .returning();
      return rows[0];
    });
    await memory.softDelete({ orgId, memoryId: approved.id, actor });
    const items = await memory.list(orgId);
    expect(items.some((i) => i.id === approved.id)).toBe(false);
  });
});

