import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

/**
 * Phase 3 integration tests — publish invariants + snapshot materialization.
 * Requires a real PostgreSQL with migrations applied (`pnpm run migrate`);
 * the compose stack is `ops/docker-compose.yml`. Skipped without DATABASE_URL.
 *
 * Exit gates exercised (imp/ledger.md Phase 3):
 *  - concurrent publish/update cannot publish a partially written version
 *  - duplicate publish of an already-published payload is a conflict
 *  - draft mutation never touches a published version
 *  - rollback inserts a NEW published version restoring the target payload
 *  - a policy_snapshot row exists for every published version, hash-equal
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

const DATABASE_URL = process.env.DATABASE_URL;

/** Reachability probe so the suite skips (not fails) without the compose stack. */
async function pgReachable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
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

const payloadA = {
  model_policy: { allowed_models: ['neryva-core-1'] },
  context_policy: { history_limit: 20 },
  tool_policy: { tools: [{ name: 'search_docs', access: 'read' }] },
  guardrail_policy: { input_policy: 'default', output_policy: 'brand-safe' },
};

const payloadB = {
  model_policy: { allowed_models: ['neryva-core-2'] },
  context_policy: { history_limit: 40 },
  tool_policy: { tools: [] },
  guardrail_policy: { input_policy: 'strict', output_policy: 'brand-safe' },
};

describeIfDb('assistants publish invariants (requires DATABASE_URL + migrations)', () => {
  let service: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let db: import('../../src/common/infra/db/db.service').DbService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const createdAssistantIds: string[] = [];

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { AssistantsService } = await import('../../src/modules/assistants/assistants.service');
    db = new DbService();
    service = new AssistantsService(db, new AuditService(db));
  });

  afterAll(async () => {
    if (createdAssistantIds.length > 0) {
      await db.withBypass(async (tx) => {
        for (const id of createdAssistantIds) {
          await tx.execute((await import('drizzle-orm')).sql`delete from assistants where id = ${id}::uuid`);
        }
      });
    }
    await db.onModuleDestroy();
  });

  async function newAssistant(name: string): Promise<string> {
    const row = await service.create({ orgId, name, createdBy: actor });
    createdAssistantIds.push(row.id);
    return row.id;
  }

  async function draft(assistantId: string, payload: typeof payloadA | typeof payloadB) {
    return service.createVersion({ orgId, assistantId, payload, createdBy: actor });
  }

  it('publish materializes a hash-equal policy snapshot in the same transaction', async () => {
    const assistantId = await newAssistant(`pub-snap-${randomUUID().slice(0, 8)}`);
    const d = await draft(assistantId, payloadA);
    const published = await service.publish({ orgId, assistantId, versionId: d.id, publishedBy: actor });

    expect(published.status).toBe('PUBLISHED');
    expect(published.version).toBe(1);
    expect(published.publishedAt).not.toBeNull();

    const snapshot = await service.getSnapshotForVersion(orgId, assistantId, published.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.hash).toBe(published.hash);
    expect(snapshot!.modelPolicy).toEqual(published.modelPolicy);
    expect(snapshot!.guardrailPolicy).toEqual(published.guardrailPolicy);
  });

  it('duplicate publish of an already-published payload is a conflict', async () => {
    const assistantId = await newAssistant(`pub-dup-${randomUUID().slice(0, 8)}`);
    const first = await draft(assistantId, payloadA);
    await service.publish({ orgId, assistantId, versionId: first.id, publishedBy: actor });

    const samePayload = await draft(assistantId, payloadA);
    await expect(service.publish({ orgId, assistantId, versionId: samePayload.id, publishedBy: actor })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('draft mutation never touches the published version', async () => {
    const assistantId = await newAssistant(`pub-imm-${randomUUID().slice(0, 8)}`);
    const d1 = await draft(assistantId, payloadA);
    const published = await service.publish({ orgId, assistantId, versionId: d1.id, publishedBy: actor });

    await draft(assistantId, payloadB);
    const reread = await service.getVersion(orgId, published.id);
    expect(reread!.hash).toBe(published.hash);
    expect(reread!.modelPolicy).toEqual(published.modelPolicy);

    const active = await service.get(orgId, assistantId);
    expect(active!.activeVersionId).toBe(published.id);
  });

  it('rollback inserts a NEW published version restoring the target payload', async () => {
    const assistantId = await newAssistant(`pub-rb-${randomUUID().slice(0, 8)}`);
    const v1draft = await draft(assistantId, payloadA);
    const v1 = await service.publish({ orgId, assistantId, versionId: v1draft.id, publishedBy: actor });
    const v2draft = await draft(assistantId, payloadB);
    const v2 = await service.publish({ orgId, assistantId, versionId: v2draft.id, publishedBy: actor });

    const rolled = await service.rollback({ orgId, assistantId, toVersionId: v1.id, publishedBy: actor });
    expect(rolled.version).toBe(3);
    expect(rolled.rollbackOf).toBe(v1.id);
    expect(rolled.hash).toBe(v1.hash);
    expect(rolled.id).not.toBe(v1.id);

    const active = await service.get(orgId, assistantId);
    expect(active!.activeVersionId).toBe(rolled.id);

    const snapshot = await service.getSnapshotForVersion(orgId, assistantId, rolled.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.hash).toBe(v1.hash);
    expect(v2.status).toBe('PUBLISHED');
  });

  it('concurrent publishes serialize to distinct fully-written versions (advisory lock)', async () => {
    const assistantId = await newAssistant(`pub-conc-${randomUUID().slice(0, 8)}`);
    const c1 = await draft(assistantId, payloadA);
    const c2 = await draft(assistantId, payloadB);

    const settled = await Promise.allSettled([
      service.publish({ orgId, assistantId, versionId: c1.id, publishedBy: actor }),
      service.publish({ orgId, assistantId, versionId: c2.id, publishedBy: actor }),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<import('../../src/modules/assistants/schema').AssistantVersion>[];
    expect(fulfilled).toHaveLength(2);

    const versions = fulfilled.map((s) => s.value.version).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2]);
    for (const v of fulfilled.map((s) => s.value)) {
      // No partially written rows: every published version carries hash + policies + snapshot.
      expect(v.hash).toHaveLength(64);
      expect(v.publishedAt).not.toBeNull();
      const snapshot = await service.getSnapshotForVersion(orgId, assistantId, v.id);
      expect(snapshot).not.toBeNull();
    }

    const active = await service.get(orgId, assistantId);
    expect([c1.id, c2.id]).toContain(active!.activeVersionId);
  });
});
