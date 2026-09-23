import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makePool, buildAssistantsService, cleanupOrg } from '../helpers/db';
import { ApiError } from '../../src/common/http/api-error';

/**
 * A2-21: discarding a DRAFT that has Try-console test runs pinned to it
 * (`runs.assistant_version_id`, no ON DELETE CASCADE) must succeed — the
 * draft-pinned test runs are deleted in the same transaction — instead of
 * exploding into a 500 FK violation. Durable references (eval_runs
 * provenance, non-test runs) refuse with a typed 409 instead of being
 * silently deleted.
 */
if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  const { TEST_DATABASE_URL } = await import('../helpers/db');
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

const basePayload = () => ({
  instructions: 'You are a discard-draft test agent.',
  model_policy: { allowed_models: ['driftprov/drift-model'] },
  context_policy: { history_limit: 5 },
  tool_policy: { tools: [] },
  guardrail_policy: {},
});

describeIfDb('discardDraft with pinned runs (A2-21, requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  const orgId = randomUUID();
  const actor = 'discard-draft-test';

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    db = new DbService();
    assistants = await buildAssistantsService(db);
  });

  afterAll(async () => {
    await db.withBypass(async (tx) => {
      await tx.execute(sql`delete from eval_runs where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from eval_datasets where organization_id = ${orgId}::uuid`);
    });
    await cleanupOrg(pool, [orgId]);
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  async function draftAssistant(name: string): Promise<{ assistantId: string; versionId: string }> {
    const { assistant } = await assistants.create({ orgId, name, createdBy: actor });
    const version = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: basePayload() as never,
      createdBy: actor,
    });
    return { assistantId: assistant.id, versionId: version.id };
  }

  /** Seed one run (+ conversation, message, snapshot, event) pinned to a draft version. */
  async function seedPinnedRun(versionId: string, runKind: string): Promise<{ runId: string }> {
    const version = await assistants.getVersion(orgId, versionId);
    if (!version) throw new Error(`seedPinnedRun: version ${versionId} missing`);
    const runId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const snapshotId = randomUUID();
    const eventId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into policy_snapshots (id, organization_id, assistant_version_id, model_policy, context_policy, tool_policy, guardrail_policy, hash)
        values (${snapshotId}::uuid, ${orgId}::uuid, ${versionId}::uuid, '{}', '{}', '{}', '{}', ${'s'.repeat(64)})`);
      await tx.execute(sql`
        insert into conversations (id, organization_id, assistant_id)
        values (${conversationId}::uuid, ${orgId}::uuid, ${version.assistantId}::uuid)`);
      await tx.execute(sql`
        insert into messages (id, conversation_id, organization_id, sequence, role, content)
        values (${messageId}::uuid, ${conversationId}::uuid, ${orgId}::uuid, 1, 'user', '{"text":"seed"}')`);
      await tx.execute(sql`
        insert into runs (id, organization_id, conversation_id, input_message_id, assistant_version_id, policy_snapshot_id, state, run_kind)
        values (${runId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${messageId}::uuid, ${versionId}::uuid, ${snapshotId}::uuid, 'COMPLETED', ${runKind})`);
      await tx.execute(sql`
        insert into run_events (id, event_id, run_id, organization_id, event_type, payload)
        values (${eventId}::uuid, ${eventId}::text, ${runId}::uuid, ${orgId}::uuid, '11', '{"case":"terminal","value":{}}')`);
    });
    return { runId };
  }

  async function seedEvalRun(versionId: string): Promise<void> {
    const datasetId = randomUUID();
    await db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into eval_datasets (id, organization_id, name, created_by)
        values (${datasetId}::uuid, ${orgId}::uuid, ${`dd-${datasetId.slice(0, 8)}`}, 'test')`);
      await tx.execute(sql`
        insert into eval_runs (id, organization_id, dataset_id, assistant_version_id, state, attempts_per_case, started_by, decision, finished_at, is_shadow, provenance)
        values (${randomUUID()}::uuid, ${orgId}::uuid, ${datasetId}::uuid, ${versionId}::uuid, 'completed', 1, 'test', 'PASS', now(), false, '{}'::jsonb)`);
    });
  }

  async function count(table: string, versionId: string, fk: string): Promise<number> {
    const rows = await db.withBypass((tx) =>
      tx.execute(sql`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(fk)} = ${versionId}::uuid`),
    );
    return (rows.rows[0] as { n: number }).n;
  }

  it('discards a draft with pinned test runs (deletes them in the same TX)', async () => {
    const { assistantId, versionId } = await draftAssistant(`dd-tried-${randomUUID().slice(0, 8)}`);
    const { runId } = await seedPinnedRun(versionId, 'test');

    await assistants.discardDraft({ orgId, assistantId, versionId, actorId: actor });

    // version gone, pinned run gone, cascaded events gone
    await expect(assistants.getVersion(orgId, versionId)).resolves.toBeFalsy();
    expect(await count('runs', versionId, 'assistant_version_id')).toBe(0);
    const evRows = await db.withBypass((tx) =>
      tx.execute(sql`select count(*)::int as n from run_events where run_id = ${runId}::uuid`),
    );
    expect((evRows.rows[0] as { n: number }).n).toBe(0);
  });

  it('still discards a fresh draft with no runs (control)', async () => {
    const { assistantId, versionId } = await draftAssistant(`dd-clean-${randomUUID().slice(0, 8)}`);
    await assistants.discardDraft({ orgId, assistantId, versionId, actorId: actor });
    await expect(assistants.getVersion(orgId, versionId)).resolves.toBeFalsy();
  });

  it('refuses with a typed 409 when eval_runs reference the draft', async () => {
    const { assistantId, versionId } = await draftAssistant(`dd-eval-${randomUUID().slice(0, 8)}`);
    await seedEvalRun(versionId);

    let caught: unknown;
    try {
      await assistants.discardDraft({ orgId, assistantId, versionId, actorId: actor });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).getStatus()).toBe(409);
    expect((caught as ApiError).code).toBe('conflict');
    expect(String((caught as ApiError).message)).toMatch(/evaluation runs/i);
    // draft survives the refusal
    const still = await assistants.getVersion(orgId, versionId);
    expect(still?.id).toBe(versionId);
  });

  it('refuses with a typed 409 when a non-test run is pinned to the draft', async () => {
    const { assistantId, versionId } = await draftAssistant(`dd-std-${randomUUID().slice(0, 8)}`);
    await seedPinnedRun(versionId, 'standard');

    let caught: unknown;
    try {
      await assistants.discardDraft({ orgId, assistantId, versionId, actorId: actor });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).getStatus()).toBe(409);
    expect((caught as ApiError).code).toBe('conflict');
    expect(String((caught as ApiError).message)).toMatch(/non-test runs/i);
    // the pinned run and the draft both survive
    expect(await count('runs', versionId, 'assistant_version_id')).toBe(1);
    const still = await assistants.getVersion(orgId, versionId);
    expect(still?.id).toBe(versionId);
  });
});
