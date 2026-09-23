import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL } from '../helpers/db';

/**
 * Wave 2 workstream 3 (quota + pricing) — proof against the live DB.
 *
 * What this proves, end to end on the real run lifecycle:
 *  1. `QuotaService.checkAndReserve` is wired into run acceptance: an
 *     over-quota run is REFUSED with the typed wall (`quota_exceeded`,
 *     429 on monthly_events) before any model spend, and the refusal
 *     leaves no Redis hold behind.
 *  2. A successful run commits the durable reservation and writes a
 *     usage-ledger entry priced from the model-cost catalog (per-model
 *     micros); an unpriced model lands a cost-NULL entry (never invented).
 *  3. cancelRun, the budget-watchdog FAILED path, the workflow-driven
 *     authority.failRun path, and approval-denial all release the durable
 *     reservation AND the Redis hold — the proof query shows zero
 *     RESERVED rows for terminal runs (failRun and decideApproval/DENIED
 *     previously leaked the Redis hold; proved by wave-4 failure injection).
 *  4. Two concurrent runs racing the last quota unit admit exactly one
 *     winner (the Redis Lua check-and-increment is atomic).
 *  5. A durable-wall refusal AFTER the Redis hold was taken drops the hold
 *     (no leak on the refusal path either).
 *
 * Pricing fixture honesty: the model-cost catalog is staff-managed and
 * ships empty (no seed process exists in migrations — the documented path
 * is `POST internal/staff/model-cost`, i.e. ModelCostService.upsertPoint).
 * The points below are TEST FIXTURES with deliberately round, unrealistic
 * numbers ($1.00 / $2.00 per 1k tokens) — they prove the pricing MATH, not
 * real prices. Production prices must be entered by staff with a documented
 * source (provider pricing page + effective date).
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
  // Read at call time: the module-load const can be stale under vitest's
  // module runner (dual evaluation), which silently gates the whole suite.
  const url = process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL;
  if (!url) return false;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000 });
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
  instructions: 'You are a helpful customer-support assistant. Be concise.',
  model_policy: { allowed_models: ['w2q-test-model'] },
  context_policy: { history_limit: 20 },
  tool_policy: { tools: [{ name: 'search_knowledge', access: 'read' }] },
  guardrail_policy: { input_policy: 'default', output_policy: 'brand-safe' },
};

const COST_PROVIDER = 'w2q-test';
const COST_MODEL = 'w2q-test-model';
const UNPRICED_MODEL = 'w2q-unpriced-model';
// Fixture prices — deliberately round/unrealistic ($1 in, $2 out per 1k).
const FIXTURE_INPUT_MICROS = 1_000_000;
const FIXTURE_OUTPUT_MICROS = 2_000_000;

const monthKey = (): string => new Date().toISOString().slice(0, 7);

describeIfDb('wave2.3 run quota + pricing (requires DATABASE_URL + redis)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let redis: import('../../src/common/infra/redis.service').RedisService;
  let assistants: import('../../src/modules/assistants/assistants.service').AssistantsService;
  let conversations: import('../../src/modules/conversations/conversations.service').ConversationsService;
  let authority: import('../../src/modules/conversations/mcp-authority.service').McpAuthorityService;
  let modelCost: import('../../src/modules/assistants/model-cost.service').ModelCostService;
  const orgIds: string[] = [];
  const actor = 'w2q-test';

  const freshOrg = (): string => {
    const id = randomUUID();
    orgIds.push(id);
    return id;
  };

  const redisEvents = async (orgId: string): Promise<number> => {
    const v = await redis.raw.get(`quota:${orgId}:agents:${monthKey()}:events`);
    return v ? Number(v) : 0;
  };

  const reservationRows = async (
    orgId: string,
  ): Promise<Array<{ run_id: string | null; state: string; dimension: string }>> => {
    const res = await db.withBypass((tx) =>
      tx.execute(sql`select run_id::text, state, dimension from quota_reservations where organization_id = ${orgId}::uuid order by created_at`),
    );
    return res.rows as Array<{ run_id: string | null; state: string; dimension: string }>;
  };

  /** The no-orphans proof: no RESERVED row may reference a terminal run. */
  const orphanedHolds = async (orgId: string): Promise<number> => {
    const res = await db.withBypass((tx) =>
      tx.execute(sql`
        select count(*)::int as n from quota_reservations qr
        join runs r on r.id = qr.run_id
        where r.organization_id = ${orgId}::uuid
          and r.state in ('COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED')
          and qr.state = 'RESERVED'
      `),
    );
    return Number((res.rows[0] as { n: number }).n);
  };

  const ledgerEntryForRun = async (orgId: string, runId: string) => {
    const res = await db.withBypass((tx) =>
      tx.execute(sql`
        select usage_kind, unit, quantity::text as quantity, estimated_cost::text as estimated_cost,
               provider, model
        from usage_ledger_entries
        where organization_id = ${orgId}::uuid and run_id = ${runId}::uuid
      `),
    );
    return res.rows as Array<{
      usage_kind: string;
      unit: string;
      quantity: string;
      estimated_cost: string | null;
      provider: string;
      model: string;
    }>;
  };

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { RedisService } = await import('../../src/common/infra/redis.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { ModelCostService } = await import('../../src/modules/assistants/model-cost.service');
    const { buildAssistantsService, buildConversationsService } = await import('../helpers/db');
    db = new DbService();
    redis = new RedisService();
    const audit = new AuditService(db);
    modelCost = new ModelCostService(db, audit);
    assistants = await buildAssistantsService(db);
    conversations = await buildConversationsService(db);

    // McpAuthorityService — the execution plane's terminal authority
    // (failRun, decideApproval). Wire the real quota graph; retrieval and
    // object storage are stubbed because neither terminal path touches them.
    const { RetentionPurgeService } = await import(
      '../../src/modules/lifecycle/retention-purge.service'
    );
    const { EscalationsService } = await import(
      '../../src/modules/conversations/escalations.service'
    );
    const { EntitlementsService } = await import(
      '../../src/modules/organizations/entitlements.service'
    );
    const { EventBus } = await import('../../src/common/events/event-bus');
    const { QuotaService } = await import('../../src/modules/billing/quota.service');
    const { McpAuthorityService } = await import(
      '../../src/modules/conversations/mcp-authority.service'
    );
    const purge = new RetentionPurgeService(db, {} as never, audit);
    const escalations = new EscalationsService(db, audit);
    const entitlements = new EntitlementsService(db, audit, new EventBus());
    const quota = new QuotaService(redis, db, entitlements);
    authority = new McpAuthorityService(db, audit, {} as never, purge, {} as never, escalations, quota);

    // Seed the catalog fixture via the documented staff path (upsertPoint =
    // POST internal/staff/model-cost). Deliberately round numbers — a math
    // fixture, not a real price.
    await modelCost.upsertPoint({
      provider: COST_PROVIDER,
      model: COST_MODEL,
      costMicrosPer1kInput: FIXTURE_INPUT_MICROS,
      costMicrosPer1kOutput: FIXTURE_OUTPUT_MICROS,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      actorId: actor,
    });
  });

  afterAll(async () => {
    await db.withBypass(async (tx) => {
      for (const orgId of orgIds) {
        await tx.execute(sql`delete from run_manifests where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from run_events where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from runs where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from messages where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from conversations where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from outbox_events where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from idempotency_records where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from usage_ledger_entries where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from quota_reservations where organization_id = ${orgId}::uuid`);
        await tx.execute(sql`delete from product_entitlements where org_id = ${orgId}`);
        await tx.execute(sql`delete from policy_snapshots where organization_id = ${orgId}::uuid`);
        await tx.execute(
          sql`delete from assistant_versions where assistant_id in (select id from assistants where organization_id = ${orgId}::uuid)`,
        );
        await tx.execute(sql`delete from assistants where organization_id = ${orgId}::uuid`);
        const keys = [
          `quota:${orgId}:agents:${monthKey()}:usd`,
          `quota:${orgId}:agents:${monthKey()}:events`,
        ];
        for (const k of keys) await redis.raw.del(k);
      }
      await tx.execute(sql`delete from model_cost_entries where provider = ${COST_PROVIDER}`);
    });
    await redis.onModuleDestroy?.();
    await db.onModuleDestroy();
  });

  async function seedEntitlement(orgId: string, limits: Record<string, number>): Promise<void> {
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into product_entitlements (id, org_id, product, plan, status, limits)
        values (gen_random_uuid(), ${orgId}, 'agents', 'w2q-test-plan', 'active', ${JSON.stringify(limits)}::jsonb)
      `),
    );
  }

  async function setup(): Promise<{ orgId: string; assistantId: string }> {
    const orgId = freshOrg();
    const { assistant } = await assistants.create({ orgId, name: `w2q-${randomUUID().slice(0, 8)}`, createdBy: actor });
    const draft = await assistants.createVersion({
      orgId,
      assistantId: assistant.id,
      payload: payloadA as never,
      createdBy: actor,
    });
    await assistants.publish({ orgId, assistantId: assistant.id, versionId: draft.id, publishedBy: actor });
    return { orgId, assistantId: assistant.id };
  }

  async function newConversation(orgId: string, assistantId: string): Promise<string> {
    const c = await conversations.createConversation({ orgId, assistantId, createdBy: actor });
    return c.id;
  }

  it('quota exceeded on the Redis plane refuses the run with code quota_exceeded (429)', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 1 });

    const conv1 = await newConversation(orgId, assistantId);
    const first = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv1,
      content: { text: 'first' },
    });
    expect(first.run_id).toBeTruthy();
    // The hold is visible: Redis event counter + durable RESERVED row.
    expect(await redisEvents(orgId)).toBe(1);
    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RESERVED']);

    const conv2 = await newConversation(orgId, assistantId);
    let refusal: { code: string; status: number; details: Record<string, unknown> } | null = null;
    try {
      await conversations.acceptMessage({
        orgId,
        principalId: actor,
        conversationId: conv2,
        content: { text: 'second' },
      });
    } catch (err) {
      refusal = err as { code: string; status: number; details: Record<string, unknown> };
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('quota_exceeded');
    expect(refusal?.status).toBe(429);
    expect(refusal?.details?.reason).toBe('product_events');

    // The refusal leaves no trace: no new hold, no durable row.
    expect(await redisEvents(orgId)).toBe(1);
    expect(await reservationRows(orgId)).toHaveLength(1);
  });

  it('successful run: reservation COMMITTED, ledger entry priced from the catalog', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 100 });

    const conv = await newConversation(orgId, assistantId);
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv,
      content: { text: 'price me' },
    });
    expect(await redisEvents(orgId)).toBe(1);

    const committed = await conversations.commitRunResult({
      orgId,
      runId: accepted.run_id as string,
      content: { text: 'answer' },
      actor,
      usage: {
        provider: COST_PROVIDER,
        model: COST_MODEL,
        promptTokens: 2000,
        completionTokens: 1000,
        totalTokens: 3000,
      },
    });
    expect(committed.replay).toBe(false);

    // Durable reservation committed; advisory hold released.
    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['COMMITTED']);
    expect(await redisEvents(orgId)).toBe(0);
    expect(await orphanedHolds(orgId)).toBe(0);

    // Ledger entry: 2000 in-tokens @ $1/1k + 1000 out-tokens @ $2/1k = $4.00.
    const entries = await ledgerEntryForRun(orgId, accepted.run_id as string);
    expect(entries).toHaveLength(1);
    expect(entries[0].usage_kind).toBe('model_tokens');
    expect(entries[0].quantity).toBe('3000.000000');
    expect(entries[0].estimated_cost).toBe('4.000000');
    expect(entries[0].provider).toBe(COST_PROVIDER);
    expect(entries[0].model).toBe(COST_MODEL);
  });

  it('unpriced model lands a cost-NULL entry — cost is never invented', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 100 });

    const conv = await newConversation(orgId, assistantId);
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv,
      content: { text: 'unpriced' },
    });
    await conversations.commitRunResult({
      orgId,
      runId: accepted.run_id as string,
      content: { text: 'answer' },
      actor,
      usage: {
        provider: COST_PROVIDER,
        model: UNPRICED_MODEL,
        promptTokens: 500,
        completionTokens: 500,
        totalTokens: 1000,
      },
    });
    const entries = await ledgerEntryForRun(orgId, accepted.run_id as string);
    expect(entries).toHaveLength(1);
    expect(entries[0].quantity).toBe('1000.000000');
    expect(entries[0].estimated_cost).toBeNull();
  });

  it('cancelRun releases the durable reservation and the Redis hold (no orphaned holds)', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 100 });

    const conv = await newConversation(orgId, assistantId);
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv,
      content: { text: 'cancel me' },
    });
    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RESERVED']);

    const canceled = await conversations.cancelRun({
      orgId,
      runId: accepted.run_id as string,
      reason: 'w2q-test cancel',
      actor,
    });
    expect(canceled.state).toBe('CANCELED');

    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RELEASED']);
    expect(await redisEvents(orgId)).toBe(0);
    expect(await orphanedHolds(orgId)).toBe(0);
  });

  it('watchdog FAILED releases the durable reservation and the Redis hold', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 100 });

    const conv = await newConversation(orgId, assistantId);
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv,
      content: { text: 'runaway' },
    });
    // The watchdog only fails RUNNING/DISPATCHED runs — move it there.
    await db.withBypass((tx) =>
      tx.execute(sql`update runs set state = 'RUNNING' where id = ${accepted.run_id}::uuid`),
    );

    const failed = await conversations.failRunForBudget({
      orgId,
      runId: accepted.run_id as string,
      reason: 'budget_exceeded_wall_clock',
      actor: 'w2q-watchdog',
    });
    expect(failed.terminal).toBe(true);

    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RELEASED']);
    expect(await redisEvents(orgId)).toBe(0);
    expect(await orphanedHolds(orgId)).toBe(0);
  });

  it('workflow-path failRun releases the durable reservation and the Redis hold', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 100 });

    const conv = await newConversation(orgId, assistantId);
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv,
      content: { text: 'doomed' },
    });
    expect(await redisEvents(orgId)).toBe(1);
    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RESERVED']);

    // This is the exact call the runtime-control workflow makes when the
    // model activity exhausts its retries (wave-4 injection: the provider
    // refused the connection mid-run). Pre-fix it released the durable
    // reservation but leaked the advisory Redis hold (+1 per FAILED run).
    const failed = await authority.failRun({
      orgId,
      runId: accepted.run_id as string,
      errorCode: 'provider_error',
      errorMessage: 'connection refused',
    });
    expect(failed.state).toBe('FAILED');

    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RELEASED']);
    expect(await redisEvents(orgId)).toBe(0);
    expect(await orphanedHolds(orgId)).toBe(0);

    // Idempotent replay must NOT release another run's hold: take a fresh
    // hold on the same org counter, replay the FAILED transition, and prove
    // the second run's hold survives.
    const conv2 = await newConversation(orgId, assistantId);
    await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv2,
      content: { text: 'innocent' },
    });
    expect(await redisEvents(orgId)).toBe(1);
    const replayed = await authority.failRun({
      orgId,
      runId: accepted.run_id as string,
      errorCode: 'provider_error',
      errorMessage: 'connection refused',
    });
    expect(replayed.state).toBe('FAILED');
    expect(await redisEvents(orgId)).toBe(1);
  });

  it('approval denial releases the durable reservation and the Redis hold', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 100 });

    const conv = await newConversation(orgId, assistantId);
    const accepted = await conversations.acceptMessage({
      orgId,
      principalId: actor,
      conversationId: conv,
      content: { text: 'risky' },
    });
    expect(await redisEvents(orgId)).toBe(1);
    // Approvals park runs that are already executing (same precedent as the
    // watchdog test — move the run to RUNNING first).
    await db.withBypass((tx) =>
      tx.execute(sql`update runs set state = 'RUNNING' where id = ${accepted.run_id}::uuid`),
    );

    const { approvalId } = await authority.createApprovalRequest({
      orgId,
      runId: accepted.run_id as string,
      approvalRef: `w2q-denial-${randomUUID()}`,
      summary: 'test denial',
      expiresAt: new Date(Date.now() + 3600_000),
      callerScope: 'w2q-test',
      createdBy: 'w2q-author',
    });

    // Pre-fix, denial left the RESERVED row AND the Redis hold behind — the
    // run's quota was never returned on the canceled path.
    const decided = await authority.decideApproval({
      orgId,
      runId: accepted.run_id as string,
      approvalId,
      decision: 'DENIED',
      actor: 'w2q-approver',
      reason: 'w2q-test denial',
    });
    expect(decided.state).toBe('DENIED');
    expect(decided.runState).toBe('CANCELED');

    expect((await reservationRows(orgId)).map((r) => r.state)).toEqual(['RELEASED']);
    expect(await redisEvents(orgId)).toBe(0);
    expect(await orphanedHolds(orgId)).toBe(0);
  });

  it('two concurrent runs racing the last quota unit admit exactly one winner', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 1 });

    const convA = await newConversation(orgId, assistantId);
    const convB = await newConversation(orgId, assistantId);
    const attempts = await Promise.allSettled([
      conversations.acceptMessage({ orgId, principalId: actor, conversationId: convA, content: { text: 'a' } }),
      conversations.acceptMessage({ orgId, principalId: actor, conversationId: convB, content: { text: 'b' } }),
    ]);
    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter((a) => a.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'quota_exceeded' });

    // Exactly one hold exists on each plane — no double-spend, no leak.
    expect(await redisEvents(orgId)).toBe(1);
    expect(await reservationRows(orgId)).toHaveLength(1);
  });

  it('durable-wall refusal after the Redis hold was taken drops the hold', async () => {
    const { orgId, assistantId } = await setup();
    await seedEntitlement(orgId, { monthly_events: 1 });
    // Pre-seed one committed usage event so the DURABLE wall (ledger count +
    // open reservations >= limit) refuses while the Redis plane still has
    // headroom — the hold must be dropped on the way out.
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into usage_ledger_entries
          (id, organization_id, usage_event_id, source_type, usage_kind, unit, quantity)
        values (gen_random_uuid(), ${orgId}::uuid, ${`w2q-seed-${randomUUID()}`}, 'test', 'model_tokens', 'tokens', 10)
      `),
    );

    const conv = await newConversation(orgId, assistantId);
    let refusal: { code: string; details: Record<string, unknown> } | null = null;
    try {
      await conversations.acceptMessage({
        orgId,
        principalId: actor,
        conversationId: conv,
        content: { text: 'nope' },
      });
    } catch (err) {
      refusal = err as { code: string; details: Record<string, unknown> };
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe('quota_exceeded');
    expect(refusal?.details?.dimension).toBe('monthly_events');

    // The Redis hold taken before the durable wall refused was released.
    expect(await redisEvents(orgId)).toBe(0);
    expect(await reservationRows(orgId)).toHaveLength(0);
  });
});
