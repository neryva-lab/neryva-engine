import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * R-2 draft evaluation (team_setup_ledger.md §3) — formal evaluation of
 * DRAFT content pre-publish (EVALUATE → PUBLISH), against live rows
 * (db-suites lane):
 * - evaluateVersion on a DRAFT synthesizes the execution snapshot and
 *   returns a run id (previously 422: PUBLISHED-only);
 * - the eval_runs row starts pending for the draft version;
 * - RETIRED versions still refuse (only live content executes);
 * - missing template dataset still 422s with the explicit-dataset guidance.
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

const payload = {
  instructions: 'You are a draft-eval probe. Be concise.',
  model_policy: { allowed_models: ['neryva-core-1'] },
  context_policy: { history_limit: 20 },
  tool_policy: { tools: [{ name: 'search_knowledge', access: 'read' }] },
  guardrail_policy: { input_policy: 'default', output_policy: 'brand-safe' },
};

describeIfDb('draft evaluation (requires DATABASE_URL)', () => {
  let service: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let db: import('../../src/common/infra/db/db.service').DbService;
  const orgId = randomUUID();
  const actor = 'draft-eval-test';
  const createdAssistantIds: string[] = [];
  let datasetId = '';

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { buildAssistantsService } = await import('../helpers/db');
    const { evalDatasets } = await import('../../src/modules/knowledge/eval.schema');
    db = new DbService();
    service = await buildAssistantsService(db);
    datasetId = randomUUID();
    await db.withBypass((tx) =>
      tx.insert(evalDatasets).values({ id: datasetId, organizationId: orgId, name: `draft-eval-${datasetId.slice(0, 8)}`, createdBy: actor }),
    );
  });

  afterAll(async () => {
    if (createdAssistantIds.length > 0) {
      await db.withBypass(async (tx) => {
        for (const id of createdAssistantIds) {
          // eval_runs references versions without cascade — delete runs first,
          // then assistants (versions + snapshots cascade from assistants).
          await tx.execute(sql`delete from eval_runs where assistant_version_id in (select id from assistant_versions where assistant_id = ${id}::uuid)`);
          await tx.execute(sql`delete from assistants where id = ${id}::uuid`);
        }
      });
    }
    await db.onModuleDestroy();
  });

  async function draftAssistant(name: string) {
    const { assistant } = await service.create({ orgId, name, createdBy: actor });
    createdAssistantIds.push(assistant.id);
    const version = await service.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: payload as unknown as import('../../src/modules/assistants/validation').AssistantPayload,
      createdBy: actor,
    });
    return { assistantId: assistant.id, versionId: version.id };
  }

  it('evaluates a DRAFT version: snapshot synthesized, run returned pending', async () => {
    const { assistantId, versionId } = await draftAssistant(`draft-eval-${randomUUID().slice(0, 8)}`);
    const run = (await service.evaluateVersion({ orgId, assistantId, versionId, datasetId, actor })) as { id: string };
    expect(typeof run.id).toBe('string');

    const snapshot = await service.getSnapshotForVersion(orgId, assistantId, versionId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.hash).toBe((await service.getVersion(orgId, versionId))!.hash);

    const { evalRuns } = await import('../../src/modules/knowledge/eval.schema');
    const rows = await db.withBypass((tx) =>
      tx.select().from(evalRuns).where(sql`${evalRuns.id} = ${run.id}::uuid`).limit(1),
    );
    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.assistantVersionId).toBe(versionId);
  });

  it('refuses evaluation of a RETIRED version', async () => {
    const { assistantId, versionId } = await draftAssistant(`draft-eval-ret-${randomUUID().slice(0, 8)}`);
    const pub1 = await service.publish({ orgId, assistantId, versionId, publishedBy: actor });
    // One-draft workspace: the successor ships through updateDraft + publish
    // (a second createVersion would 409 draft_exists).
    const current = await service.getVersion(orgId, versionId);
    await service.updateDraft({
      orgId,
      assistantId,
      versionId,
      payload: { ...payload, instructions: 'You are a draft-eval probe v2. Be concise.' } as unknown as import('../../src/modules/assistants/validation').AssistantPayload,
      expectedHash: current!.hash,
      actorId: actor,
    });
    await service.publish({ orgId, assistantId, versionId, publishedBy: actor });
    // pub1 is PUBLISHED and no longer active → retire is legal.
    await service.retire({ orgId, assistantId, versionId: pub1.id, retiredBy: actor });
    await expect(service.evaluateVersion({ orgId, assistantId, versionId: pub1.id, datasetId, actor })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('keeps the explicit-dataset guidance when no template dataset exists', async () => {
    const { assistantId, versionId } = await draftAssistant(`draft-eval-nods-${randomUUID().slice(0, 8)}`);
    await expect(service.evaluateVersion({ orgId, assistantId, versionId, actor })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
