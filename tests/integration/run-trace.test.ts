import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool } from '../helpers/db';

/**
 * P1 (ai-native-review.md §6a) — one trace id from accept to completion
 * substrate: acceptMessage mints it when the caller supplies none, pins it
 * into the run manifest JSON (execution identity) AND the run.created outbox
 * event (async propagation). A caller-supplied trace id flows through
 * unchanged (upstream continuation).
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  if (
    !process.env.DATABASE_URL &&
    !(await import('../helpers/db').then((m) => m.TEST_DATABASE_URL))
  )
    return false;
  const { Pool } = await import('pg');
  const { TEST_DATABASE_URL } = await import('../helpers/db');
  if (!TEST_DATABASE_URL) return false;
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
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
  instructions: 'You are a trace test agent.',
  model_policy: { allowed_models: ['neryva-core-1'] },
  context_policy: { history_limit: 5 },
  tool_policy: { tools: [] },
  guardrail_policy: {},
};

describeIfDb('run trace identity (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const assistantIds: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    db = new DbService();
    assistants = await buildAssistantsService(db);
    conversations = await buildConversationsService(db);
  });

  afterAll(async () => {
    // Full org cleanup — runs, manifests, and the PENDING outbox rows this
    // suite emits must not starve other suites' dispatchers on the shared DB.
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    void assistantIds;
    void conversationIds;
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  async function setupRun() {
    const { assistant } = await assistants.create({
      orgId,
      name: `trace-${randomUUID().slice(0, 8)}`,
      createdBy: actor,
    });
    assistantIds.push(assistant.id);
    const draft = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload:
        payloadA as unknown as import('../../src/modules/assistants/validation').AssistantPayload,
      createdBy: actor,
    });
    await assistants.publish({
      orgId,
      assistantId: assistant.id,
      versionId: draft.id,
      publishedBy: actor,
    });
    const conversation = await conversations.createConversation({
      orgId,
      assistantId: assistant.id,
      createdBy: actor,
    });
    conversationIds.push(conversation.id);
    return conversation.id;
  }

  async function manifestAndOutbox(runId: string) {
    return db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      const m = await tx.execute(
        sql`select manifest from run_manifests where run_id = ${runId}::uuid`,
      );
      const o = await tx.execute(
        sql`select trace_id from outbox_events where aggregate_id = ${runId}::uuid and event_type = 'run.created' order by created_at desc limit 1`,
      );
      // Raw execute() returns jsonb unparsed on this path — parse it.
      const rawManifest = (m.rows[0] as { manifest: unknown } | undefined)?.manifest;
      const manifest = (typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest) as
        { trace_id?: unknown } | undefined;
      return {
        manifest,
        outboxTraceId: (o.rows[0] as { trace_id?: unknown } | undefined)?.trace_id ?? null,
      };
    });
  }

  it('mints one trace id into manifest + outbox when the caller supplies none', async () => {
    const conversationId = await setupRun();
    const result = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId,
      content: { text: 'trace me' },
      idempotencyKey: `idem-${randomUUID()}`,
    });
    expect(result.run_id).toBeTruthy();
    const { manifest, outboxTraceId } = await manifestAndOutbox(result.run_id as string);
    expect(manifest?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(outboxTraceId).toBe(manifest?.trace_id);
  });

  it('propagates a caller-supplied trace id unchanged', async () => {
    const conversationId = await setupRun();
    const external = 'f'.repeat(32);
    const result = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId,
      content: { text: 'trace me too' },
      idempotencyKey: `idem-${randomUUID()}`,
      traceId: external,
    });
    const { manifest, outboxTraceId } = await manifestAndOutbox(result.run_id as string);
    expect(manifest?.trace_id).toBe(external);
    expect(outboxTraceId).toBe(external);
  });
});
