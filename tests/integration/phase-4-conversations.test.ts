import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * Phase 4 integration — start-message transaction, idempotency, one-active-turn,
 * CommitRunResult atomicity + replay, cancel, cursor pagination.
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
  model_policy: { allowed_models: ['neryva-core-1'] },
  context_policy: { history_limit: 20 },
  tool_policy: { tools: [{ name: 'search_docs', access: 'read' }] },
  guardrail_policy: { input_policy: 'default', output_policy: 'brand-safe' },
};

describeIfDb('conversation plane (requires DATABASE_URL + migrations)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const assistantIds: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { AssistantsService } = await import('../../src/modules/assistants/assistants.service');
    const { ConversationsService } = await import('../../src/modules/conversations/conversations.service');
    db = new DbService();
    const audit = new AuditService(db);
    assistants = new AssistantsService(db, audit);
    conversations = new ConversationsService(db, audit);
  });

  afterAll(async () => {
    if (assistantIds.length > 0) {
      await db.withBypass(async (tx) => {
        for (const id of assistantIds) {
          await tx.execute((await import('drizzle-orm')).sql`delete from assistants where id = ${id}::uuid`);
        }
        for (const id of conversationIds) {
          await tx.execute((await import('drizzle-orm')).sql`delete from conversations where id = ${id}::uuid`);
        }
      });
    }
    await db.onModuleDestroy();
  });

  async function publishedAssistant(): Promise<string> {
    const assistant = await assistants.create({ orgId, name: `conv-${randomUUID().slice(0, 8)}`, createdBy: actor });
    assistantIds.push(assistant.id);
    const draft = await assistants.createVersion({ orgId, assistantId: assistant.id, payload: payloadA, createdBy: actor });
    await assistants.publish({ orgId, assistantId: assistant.id, versionId: draft.id, publishedBy: actor });
    return assistant.id;
  }

  it('start-message transaction: message + run + outbox land atomically', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);

    const result = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conversation.id,
      content: { text: 'hello' },
      idempotencyKey: `idem-${randomUUID()}`,
    });
    expect(result.sequence).toBe(1);
    expect(result.conversation_version).toBe(2);

    const outbox = await db.withBypass(async (tx) => {
      const res = await tx.execute((await import('drizzle-orm')).sql`select event_type, status from outbox_events where aggregate_id = ${result.run_id}::uuid`);
      return res.rows as Array<{ event_type: string; status: string }>;
    });
    expect(outbox.some((r) => r.event_type === 'run.created' && r.status === 'PENDING')).toBe(true);

    const run = await conversations.getRun(orgId, result.run_id);
    expect(run?.state).toBe('ACCEPTED');
    expect(run?.assistantVersionId).toBeTruthy();
    expect(run?.policySnapshotId).toBeTruthy();
  });

  it('duplicate idempotency key replays the original result; different payload conflicts', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);
    const key = `idem-${randomUUID()}`;

    const first = await conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'one' }, idempotencyKey: key });
    const replay = await conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'one' }, idempotencyKey: key });
    expect(replay.message_id).toBe(first.message_id);
    expect(replay.replay).toBe(true);

    await expect(
      conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'different' }, idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('one active turn per conversation is enforced by the DB', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);
    await conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'first' } });
    await expect(
      conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'second' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('stale expected_conversation_version is a typed conflict with no side effect', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);
    await expect(
      conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'x' }, expectedConversationVersion: 99 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const page = await conversations.listMessages(orgId, conversation.id);
    expect(page.messages).toHaveLength(0);
  });

  it('commitRunResult is atomic, replayable, and publishes a terminal event', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);
    const accepted = await conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'q' } });

    const first = await conversations.commitRunResult({ orgId, runId: accepted.run_id, content: { text: 'answer' }, actor });
    expect(first.replay).toBe(false);
    const replay = await conversations.commitRunResult({ orgId, runId: accepted.run_id, content: { text: 'answer' }, actor });
    expect(replay.message_id).toBe(first.message_id);
    expect(replay.replay).toBe(true);

    const run = await conversations.getRun(orgId, accepted.run_id);
    expect(run?.state).toBe('COMPLETED');
    expect(run?.resultMessageId).toBe(first.message_id);

    const events = await conversations.listRunEvents(orgId, accepted.run_id);
    expect(events.events.some((e) => e.eventType === 'run.completed')).toBe(true);

    // Terminal run accepts no further turns.
    await expect(
      conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'again' } }),
    ).rejects.toBeTruthy();
  });

  it('cancel transitions a live run and rejects terminal reruns', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);
    const accepted = await conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: 'cancel me' } });
    const canceled = await conversations.cancelRun({ orgId, runId: accepted.run_id, reason: 'test', actor });
    expect(canceled.state).toBe('CANCELED');
    await expect(conversations.cancelRun({ orgId, runId: accepted.run_id, reason: 'again', actor })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('message cursor pagination is stable and ordered', async () => {
    const assistantId = await publishedAssistant();
    const conversation = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    conversationIds.push(conversation.id);
    // Complete each run to allow the next turn.
    for (let i = 0; i < 3; i++) {
      const accepted = await conversations.acceptMessage({ orgId, principalId: actor, conversationId: conversation.id, content: { text: `m${i}` } });
      await conversations.commitRunResult({ orgId, runId: accepted.run_id, content: { text: `a${i}` }, actor });
    }
    const page1 = await conversations.listMessages(orgId, conversation.id, { limit: 2 });
    expect(page1.messages.map((m) => m.sequence)).toEqual([1, 2]);
    expect(page1.next_cursor).toBe(2);
    const page2 = await conversations.listMessages(orgId, conversation.id, { afterSequence: page1.next_cursor ?? 0, limit: 2 });
    expect(page2.messages.map((m) => m.sequence)).toEqual([3, 4]);
  });
});
