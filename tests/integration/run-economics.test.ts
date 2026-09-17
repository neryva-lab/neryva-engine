import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool } from '../helpers/db';

/**
 * P2 (ai-native-review.md) engine half, over live HTTP-shaped service calls:
 * - cache economics: commit with a cache split lands metadata + cached-rate
 *   pricing; inconsistent splits refuse with 422;
 * - wall-clock watchdog: an over-age RUNNING run fails closed with quota
 *   released, a terminal event, and a run.failed outbox event; in-budget and
 *   non-executing runs are untouched;
 * - overflow enabler: getAuthorizedRunContext carries per-alias windows from
 *   the platform catalog (null when unknown).
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  const { TEST_DATABASE_URL } = await import('../helpers/db');
  if (!TEST_DATABASE_URL) return false;
  const { Pool } = await import('pg');
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

describeIfDb('run economics (requires DATABASE_URL)', () => {
  const pool = makePool();
  let db: import('../../src/common/infra/db/db.service').DbService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  const orgId = randomUUID();
  const actor = 'integration-test';
  const assistantIds: string[] = [];
  const conversationIds: string[] = [];

  const payloadFor = (models: string[], wallClock?: number) => ({
    instructions: 'You are an economics test agent.',
    model_policy: { allowed_models: models },
    context_policy: { history_limit: 5 },
    tool_policy: { tools: [] },
    guardrail_policy: {},
    ...(wallClock === undefined ? {} : { budget_policy: { wall_clock_seconds: wallClock } }),
  });

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    db = new DbService();
    assistants = await buildAssistantsService(db);
    conversations = await buildConversationsService(db);
    // Priced model with a cached-input rate (10x cheaper hits).
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`
        insert into model_cost_entries (id, provider, model, cost_micros_per_1k_input, cost_micros_per_1k_output, cost_micros_per_1k_cached_input, created_by)
        values (${randomUUID()}::uuid, 'econ', 'split-model', 3000, 6000, 300, 'integration-test')`);
      await tx.execute(sql`
        insert into model_catalog_entries (id, provider, model_id, display_name, context_window_tokens, status)
        values (${randomUUID()}::uuid, 'econ', 'window-model', 'Econ Window', 128000, 'active')`);
    });
  });

  afterAll(async () => {
    // Full org cleanup (runs, manifests, outbox, ledger, idempotency — the
    // PENDING outbox rows this suite emits must not starve other suites'
    // dispatchers on the shared DB) + the GLOBAL seed rows it owns.
    const { cleanupOrg } = await import('../helpers/db');
    await cleanupOrg(pool, [orgId]);
    await db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql`delete from model_cost_entries where provider = 'econ' and model = 'split-model'`);
      await tx.execute(sql`delete from model_catalog_entries where provider = 'econ' and model_id = 'window-model'`);
    });
    void assistantIds;
    void conversationIds;
    pool.end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  async function publishedAssistant(models: string[], wallClock?: number): Promise<string> {
    const { assistant } = await assistants.create({
      orgId,
      name: `econ-${randomUUID().slice(0, 8)}`,
      createdBy: actor,
    });
    assistantIds.push(assistant.id);
    const draft = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: payloadFor(models, wallClock) as never,
      createdBy: actor,
    });
    await assistants.publish({
      orgId,
      assistantId: assistant.id,
      versionId: draft.id,
      publishedBy: actor,
    });
    return assistant.id;
  }

  async function acceptedRun(assistantId: string, text: string): Promise<string> {
    const conversation = await conversations.createConversation({
      orgId,
      assistantId,
      createdBy: actor,
    });
    conversationIds.push(conversation.id);
    const result = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conversation.id,
      content: { text },
      idempotencyKey: `idem-${randomUUID()}`,
    });
    return result.run_id as string;
  }

  async function ledgerRow(runId: string) {
    return db.withBypass(async (tx) => {
      const { sql } = await import('drizzle-orm');
      const rows = await tx.execute(
        sql`select quantity, estimated_cost, metadata from usage_ledger_entries where run_id = ${runId}::uuid`,
      );
      return rows.rows[0] as
        { quantity: string; estimated_cost: string | null; metadata: unknown } | undefined;
    });
  }

  it('prices cache hits at the cached rate and records the split', async () => {
    const assistantId = await publishedAssistant(['econ/split-model']);
    const runId = await acceptedRun(assistantId, 'price my cache');
    await conversations.commitRunResult({
      orgId,
      runId,
      content: { text: 'done' },
      actor,
      usage: {
        provider: 'econ',
        model: 'split-model',
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        promptCacheHitTokens: 800,
      },
    });
    const row = await ledgerRow(runId);
    expect(row).toBeTruthy();
    // 200 uncached @3000 + 800 cached @300 + 500 out @6000 = 3840 micros = $0.003840.
    expect(row?.estimated_cost).toBe('0.003840');
    const meta = (
      typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : row?.metadata
    ) as Record<string, unknown>;
    expect(meta.prompt_cache_hit_tokens).toBe(800);
    expect(meta.prompt_cache_miss_tokens).toBe(200);
  });

  it('refuses inconsistent cache splits with 422', async () => {
    const assistantId = await publishedAssistant(['econ/split-model']);
    const runId = await acceptedRun(assistantId, 'price my bad split');
    await expect(
      conversations.commitRunResult({
        orgId,
        runId,
        content: { text: 'done' },
        actor,
        usage: {
          provider: 'econ',
          model: 'split-model',
          promptTokens: 1000,
          completionTokens: 0,
          totalTokens: 1000,
          promptCacheHitTokens: 400,
          promptCacheMissTokens: 700,
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('watchdog fails over-age executing runs closed, spares the rest', async () => {
    const { RunWatchdogWorker } = await import('../../src/workers/run-watchdog.worker');
    const watchdog = new RunWatchdogWorker(db, conversations);
    const assistantId = await publishedAssistant(['econ/split-model'], 1);
    const oldRun = await acceptedRun(assistantId, 'old run');
    const freshRun = await acceptedRun(assistantId, 'fresh run');
    const { sql } = await import('drizzle-orm');
    await db.withBypass(async (tx) => {
      // Old: RUNNING since 2h ago (budget says 1s). Fresh: RUNNING now.
      await tx.execute(
        sql`update runs set state = 'RUNNING', accepted_at = now() - interval '2 hours' where id = ${oldRun}::uuid`,
      );
      await tx.execute(sql`update runs set state = 'RUNNING' where id = ${freshRun}::uuid`);
    });
    // Scoped sweep (test seam): only this org's runs may fail here.
    await watchdog.tick(orgId);
    const rows = await db.withBypass(async (tx) => {
      const r = await tx.execute(
        sql`select id, state, terminal_reason from runs where id in (${oldRun}::uuid, ${freshRun}::uuid)`,
      );
      return r.rows as Array<{ id: string; state: string; terminal_reason: string | null }>;
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(oldRun)?.state).toBe('FAILED');
    expect(byId.get(oldRun)?.terminal_reason).toBe('budget_exceeded_wall_clock');
    expect(byId.get(freshRun)?.state).toBe('RUNNING');
    // Terminal event + outbox for the killed run.
    const side = await db.withBypass(async (tx) => {
      const e = await tx.execute(
        sql`select count(*)::int as n from run_events where run_id = ${oldRun}::uuid and event_type = 'run.failed'`,
      );
      const o = await tx.execute(
        sql`select count(*)::int as n from outbox_events where aggregate_id = ${oldRun}::uuid and event_type = 'run.failed'`,
      );
      return { events: (e.rows[0] as { n: number }).n, outbox: (o.rows[0] as { n: number }).n };
    });
    expect(side.events).toBe(1);
    expect(side.outbox).toBe(1);
  });

  it('exposes catalog windows on the authorized context', async () => {
    const { McpAuthorityService } =
      await import('../../src/modules/conversations/mcp-authority.service');
    const audit = new (await import('../../src/common/audit/audit.service')).AuditService(db);
    // Hand-built with the same collaborators the module wires (retrieval only
    // touches the DB on the paths below; storage/purge/escalations unused).
    const { RetrievalService } = await import('../../src/modules/knowledge/retrieval.service');
    const { EmbeddingService } = await import('../../src/modules/knowledge/embedding.service');
    const { RerankerService } = await import('../../src/modules/knowledge/reranker.port');
    const { QueryRewriteService } = await import('../../src/modules/knowledge/query-rewrite.port');
    const nullConfig = { latest: async () => null } as never;
    const retrieval = new RetrievalService(
      db,
      new EmbeddingService(),
      new RerankerService(),
      new QueryRewriteService(),
      nullConfig,
    );
    const authority = new McpAuthorityService(
      db,
      audit,
      undefined as never,
      undefined as never,
      retrieval,
      undefined as never,
    );
    const assistantId = await publishedAssistant(['econ/window-model', 'econ/unknown-model']);
    const runId = await acceptedRun(assistantId, 'window check');
    const ctx = await authority.getAuthorizedRunContext({ orgId, runId });
    expect(ctx.modelWindows['econ/window-model']).toBe(128000);
    expect(ctx.modelWindows['econ/unknown-model']).toBeNull();
  });
});
