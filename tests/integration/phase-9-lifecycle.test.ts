import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * Phase 9 integration — retention sweep eligibility, legal hold blocking,
 * the ordered purge workflow to tombstone, and the one-time export download.
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

const payloadA = {
  instructions: 'You are a helpful customer-support assistant. Be concise, friendly, and cite knowledge sources when used.',
  model_policy: { allowed_models: ['neryva-core-1'] },
  context_policy: {},
  tool_policy: {},
  guardrail_policy: {},
};

describeIfDb('lifecycle workflows (requires DATABASE_URL + migrations)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  let retention: import('../../src/modules/lifecycle/retention-purge.service').RetentionPurgeService;
  let lifecycle: import('../../src/modules/lifecycle/lifecycle.service').LifecycleService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const assistantIds: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { RetentionPurgeService } = await import('../../src/modules/lifecycle/retention-purge.service');
    const { LifecycleService } = await import('../../src/modules/lifecycle/lifecycle.service');
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    db = new DbService();
    const audit = new AuditService(db);
    assistants = await buildAssistantsService(db);
    conversations = await buildConversationsService(db);
    retention = new RetentionPurgeService(db, { requireAvailable: () => undefined, deleteObject: async () => true } as never, audit);
    lifecycle = new LifecycleService(db, { requireAvailable: () => undefined, deleteObject: async () => true } as never, audit);
  });

  afterAll(async () => {
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      for (const id of conversationIds) {
        await tx.execute(sql`delete from tombstones where resource_id = ${id}::uuid`);
        await tx.execute(sql`delete from conversations where id = ${id}::uuid`);
      }
      for (const id of assistantIds) {
        await tx.execute(sql`delete from assistants where id = ${id}::uuid`);
      }
      await tx.execute(sql`delete from purge_tasks where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from legal_holds where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from export_requests where organization_id = ${orgId}::uuid`);
      await tx.execute(sql`delete from data_access_records where organization_id = ${orgId}::uuid`);
    });
    await db.onModuleDestroy();
  });

  async function newConversation(): Promise<string> {
    const { assistant } = await assistants.create({ orgId, name: `lc-${randomUUID().slice(0, 8)}`, createdBy: actor });
    assistantIds.push(assistant.id);
    const draft = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: payloadA as unknown as import('../../src/modules/assistants/validation').AssistantPayload,
      createdBy: actor,
    });
    await assistants.publish({ orgId, assistantId: assistant.id, versionId: draft.id, publishedBy: actor });
    const conversation = await conversations.createConversation({ orgId, assistantId: assistant.id, createdBy: actor });
    conversationIds.push(conversation.id);
    return conversation.id;
  }

  async function driveToCompletion(taskId: string, maxTicks = 12): Promise<{ state: string; step: string }> {
    for (let i = 0; i < maxTicks; i++) {
      await retention.tick();
      const task = await retention.getPurgeTask(orgId, taskId);
      if (task && (task.state === 'done' || task.state === 'failed' || task.state === 'blocked')) {
        return { state: task.state, step: task.step };
      }
    }
    const task = await retention.getPurgeTask(orgId, taskId);
    return { state: task?.state ?? 'missing', step: task?.step ?? 'missing' };
  }

  it('purge workflow runs the pinned order to done and leaves a tombstone', async () => {
    const conversationId = await newConversation();
    const task = await retention.enqueuePurge({ orgId, scopeType: 'conversation', scopeId: conversationId, reason: 'user_request', actor });
    const result = await driveToCompletion(task.id);
    expect(result.state).toBe('done');

    const tombstone = await lifecycle.tombstoneFor('conversation', conversationId);
    expect(tombstone).not.toBeNull();

    // Stale ID reads are rejected after purge.
    await expect(retention.assertNotTombstoned('conversation', conversationId)).rejects.toMatchObject({ code: 'resource_purged' });
  });

  it('an active legal hold blocks the purge; release unblocks', async () => {
    const conversationId = await newConversation();
    await lifecycle.placeHold({ orgId, scopeType: 'conversation', scopeId: conversationId, reason: 'litigation', actor });

    const task = await retention.enqueuePurge({ orgId, scopeType: 'conversation', scopeId: conversationId, reason: 'user_request', actor });
    const result = await driveToCompletion(task.id);
    expect(result.state).toBe('blocked');
    expect(await lifecycle.tombstoneFor('conversation', conversationId)).toBeNull();

    // Release → the task can proceed to completion.
    const holds = await lifecycle.listHolds(orgId);
    const hold = holds.find((h) => h.scopeId === conversationId && h.status === 'active');
    await lifecycle.releaseHold({ orgId, holdId: hold!.id, actor });
    const resumed = await driveToCompletion(task.id);
    expect(resumed.state).toBe('done');
  });

  it('export manifest is RLS-scoped and the download token is one-time', async () => {
    const conversationId = await newConversation();
    const request = await lifecycle.createExport({ orgId, actor, scope: { conversation_ids: [conversationId] } });
    expect(request.state).toBe('ready');
    const manifest = request.manifest as { items: unknown[] };
    expect(manifest.items).toHaveLength(1);

    const first = await lifecycle.downloadExport({ orgId, exportId: request.id, token: 'token-one-time', actor });
    expect(first).toBeTruthy();
    await expect(lifecycle.downloadExport({ orgId, exportId: request.id, token: 'token-one-time', actor })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(lifecycle.downloadExport({ orgId, exportId: request.id, token: 'wrong-token', actor })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('data access records capture sensitive reads separately from audit', async () => {
    const rows = await db.withBypass(async (tx) => {
      const res = await tx.execute((await import('drizzle-orm')).sql`select access_type, count(*) as n from data_access_records where organization_id = ${orgId}::uuid group by 1`);
      return res.rows as Array<{ access_type: string; n: string }>;
    });
    expect(rows.some((r) => r.access_type === 'export_download')).toBe(true);
  });
});
