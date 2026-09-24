import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, makePool, seedOrgChain, cleanupOrg } from '../helpers/db';

/**
 * Wave 4 workstream 3, GAP 1 — approval expiry sweeper.
 *
 * Regression: an approval whose `expires_at` passes while PENDING was never
 * transitioned (no sweeper existed). The run parked at the approval gate
 * stayed non-terminal and its quota hold was stranded until an explicit
 * cancel. The fix is `McpAuthorityService.sweepExpiredApprovals` + the
 * `ApprovalExpirySweepWorker` interval worker:
 *  - expired PENDING approvals → EXPIRED (fail closed: never auto-approve),
 *  - the parked run → CANCELED with terminal_reason 'approval_expired',
 *  - the durable quota reservation → RELEASED and the advisory Redis hold
 *    returned, in the same settlement as the denial path,
 *  - a `run.canceled` outbox event (drives the existing run-cancel
 *    consumer → Studio workflow cancellation).
 *
 * Proved against the live DB (db-suites lane):
 *  1. expired PENDING approvals (run WAITING_APPROVAL and run DISPATCHED)
 *     → approval EXPIRED, run CANCELED, reservation RELEASED, outbox
 *     `run.canceled` written.
 *  2. non-expired PENDING approvals are untouched.
 *  3. already-decided approvals (APPROVED/DENIED) are untouched even when
 *     their expires_at is in the past.
 *  4. re-sweep is idempotent: second sweep expires nothing and writes no
 *     duplicate outbox/audit rows.
 *  5. an approval that expired while its run is already terminal still gets
 *     its row marked EXPIRED, but the run and quota are left alone (the
 *     terminal path already settled them).
 *  6. when the sweep terminalizes a run, every OTHER still-PENDING approval
 *     on that run is expired in the same TX — including a sibling whose
 *     window has not elapsed — so a canceled run never retains a live
 *     approval.
 *  7. decideApproval after expires_at fails closed with conflict
 *     'approval expired' (APPROVED and DENIED) — a late decision can never
 *     race the sweep and resume/deny a run the sweep is canceling.
 */

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

async function pgReachable(): Promise<boolean> {
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

describeIfDb('approval expiry sweep (requires DATABASE_URL + redis)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let redis: import('../../src/common/infra/redis.service').RedisService;
  let authority: import('../../src/modules/conversations/mcp-authority.service').McpAuthorityService;
  const pool = TEST_DATABASE_URL ? makePool() : null;
  const orgId = randomUUID();

  const monthKey = (): string => new Date().toISOString().slice(0, 7);

  async function fixtureIds(): Promise<{
    assistantId: string;
    messageId: string;
    versionId: string;
    snapshotId: string;
  }> {
    const asst = await db.withBypass((tx) =>
      tx.execute(sql`select id from assistants where organization_id = ${orgId}::uuid limit 1`),
    );
    const msg = await db.withBypass((tx) =>
      tx.execute(sql`select id from messages where organization_id = ${orgId}::uuid limit 1`),
    );
    const ver = await db.withBypass((tx) =>
      tx.execute(sql`select id from assistant_versions where organization_id = ${orgId}::uuid limit 1`),
    );
    const snap = await db.withBypass((tx) =>
      tx.execute(sql`select id from policy_snapshots where organization_id = ${orgId}::uuid limit 1`),
    );
    return {
      assistantId: (asst.rows[0] as { id: string }).id,
      messageId: (msg.rows[0] as { id: string }).id,
      versionId: (ver.rows[0] as { id: string }).id,
      snapshotId: (snap.rows[0] as { id: string }).id,
    };
  }

  async function seedParkedRun(
    ids: Awaited<ReturnType<typeof fixtureIds>>,
    runState: string,
    approvalState: 'PENDING' | 'APPROVED' | 'DENIED',
    expiresInMinutes: number,
  ): Promise<{ runId: string; approvalId: string }> {
    const runId = randomUUID();
    const approvalId = randomUUID();
    // One active run per conversation (uq_runs_one_active_per_conversation),
    // so each parked run gets its own conversation + message.
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into conversations (id, organization_id, assistant_id)
        values (${conversationId}::uuid, ${orgId}::uuid, ${ids.assistantId}::uuid)
      `),
    );
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into messages (id, conversation_id, organization_id, sequence, role, content)
        values (${messageId}::uuid, ${conversationId}::uuid, ${orgId}::uuid, 1, 'user', '{"text":"sweep fixture"}')
      `),
    );
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into runs (id, organization_id, conversation_id, input_message_id,
                          assistant_version_id, policy_snapshot_id, state, run_kind, version)
        values (${runId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${messageId}::uuid,
                ${ids.versionId}::uuid, ${ids.snapshotId}::uuid, ${runState}, 'standard', 1)
      `),
    );
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into approvals (id, organization_id, run_id, approval_ref, summary, state, expires_at,
                               decided_at, decision_actor_id)
        values (${approvalId}::uuid, ${orgId}::uuid, ${runId}::uuid,
                ${'sweep-' + approvalId.slice(0, 8)}, 'sweep fixture', ${approvalState},
                now() + (${expiresInMinutes} || ' minutes')::interval,
                case when ${approvalState} = 'PENDING' then null else now() end,
                case when ${approvalState} = 'PENDING' then null else 'fixture' end)
      `),
    );
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into quota_reservations (id, organization_id, dimension, quantity, state, run_id, expires_at)
        values (${randomUUID()}::uuid, ${orgId}::uuid, 'requests', 1, 'RESERVED',
                ${runId}::uuid, now() + interval '1 hour')
      `),
    );
    // Advisory hold mirroring the durable reservation (what the smoke measures).
    await redis.raw.incr(`quota:${orgId}:agents:${monthKey()}:events`);
    return { runId, approvalId };
  }

  const approvalRow = async (approvalId: string) => {
    const res = await db.withBypass((tx) =>
      tx.execute(
        sql`select state, decided_at::text as decided_at, decision_actor_id from approvals where id = ${approvalId}::uuid`,
      ),
    );
    return res.rows[0] as { state: string; decided_at: string | null; decision_actor_id: string | null };
  };

  const runRow = async (runId: string) => {
    const res = await db.withBypass((tx) =>
      tx.execute(
        sql`select state, terminal_reason, finished_at::text as finished_at from runs where id = ${runId}::uuid`,
      ),
    );
    return res.rows[0] as { state: string; terminal_reason: string | null; finished_at: string | null };
  };

  const reservationState = async (runId: string) => {
    const res = await db.withBypass((tx) =>
      tx.execute(sql`select state from quota_reservations where run_id = ${runId}::uuid`),
    );
    return (res.rows[0] as { state: string } | undefined)?.state ?? null;
  };

  const outboxCanceledCount = async (runId: string) => {
    const res = await db.withBypass((tx) =>
      tx.execute(sql`
        select count(*)::int as n from outbox_events
        where organization_id = ${orgId}::uuid and aggregate_id = ${runId} and event_type = 'run.canceled'
      `),
    );
    return Number((res.rows[0] as { n: number }).n);
  };

  /** P5-A8: the sweep's run.canceled payload must satisfy the run-cancel consumer. */
  const outboxCanceledPayload = async (runId: string) => {
    const res = await db.withBypass((tx) =>
      tx.execute(sql`
        select payload from outbox_events
        where organization_id = ${orgId}::uuid and aggregate_id = ${runId} and event_type = 'run.canceled'
        order by created_at desc limit 1
      `),
    );
    // Raw tx.execute returns jsonb as a string (pg-types.ts 3802 override).
    const raw = (res.rows[0] as { payload: string | Record<string, unknown> } | undefined)?.payload;
    return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
  };

  const redisEvents = async (): Promise<number> => {
    const v = await redis.raw.get(`quota:${orgId}:agents:${monthKey()}:events`);
    return v ? Number(v) : 0;
  };

  /** Inserts one more approval row on an existing run (multi-approval runs). */
  async function seedApproval(
    runId: string,
    approvalState: 'PENDING' | 'APPROVED' | 'DENIED',
    expiresInMinutes: number,
  ): Promise<string> {
    const approvalId = randomUUID();
    await db.withBypass((tx) =>
      tx.execute(sql`
        insert into approvals (id, organization_id, run_id, approval_ref, summary, state, expires_at,
                               decided_at, decision_actor_id)
        values (${approvalId}::uuid, ${orgId}::uuid, ${runId}::uuid,
                ${'sweep-' + approvalId.slice(0, 8)}, 'sweep sibling', ${approvalState},
                now() + (${expiresInMinutes} || ' minutes')::interval,
                case when ${approvalState} = 'PENDING' then null else now() end,
                case when ${approvalState} = 'PENDING' then null else 'fixture' end)
      `),
    );
    return approvalId;
  }

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { RedisService } = await import('../../src/common/infra/redis.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    const { RetentionPurgeService } = await import('../../src/modules/lifecycle/retention-purge.service');
    const { EscalationsService } = await import('../../src/modules/conversations/escalations.service');
    const { EntitlementsService } = await import('../../src/modules/organizations/entitlements.service');
    const { EventBus } = await import('../../src/common/events/event-bus');
    const { QuotaService } = await import('../../src/modules/billing/quota.service');
    const { McpAuthorityService } = await import('../../src/modules/conversations/mcp-authority.service');
    db = new DbService();
    redis = new RedisService();
    const audit = new AuditService(db);
    const purge = new RetentionPurgeService(db, {} as never, audit);
    const escalations = new EscalationsService(db, audit);
    const entitlements = new EntitlementsService(db, audit, new EventBus());
    const quota = new QuotaService(redis, db, entitlements);
    authority = new McpAuthorityService(db, audit, {} as never, purge, {} as never, escalations, quota);
    await seedOrgChain(pool as NonNullable<typeof pool>, orgId);
  });

  afterAll(async () => {
    await cleanupOrg(pool as NonNullable<typeof pool>, [orgId]);
    await redis.raw.del(`quota:${orgId}:agents:${monthKey()}:events`);
    (pool as NonNullable<typeof pool>).end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  it('expires overdue PENDING approvals: approval EXPIRED, run CANCELED, quota RELEASED', async () => {
    const ids = await fixtureIds();
    const parked = await seedParkedRun(ids, 'WAITING_APPROVAL', 'PENDING', -20);
    const dispatched = await seedParkedRun(ids, 'DISPATCHED', 'PENDING', -20);
    const holdsBefore = await redisEvents();

    const result = await authority.sweepExpiredApprovals({ orgId });
    const expiredIds = result.sweptApprovals.map((e) => e.approvalId);
    expect(expiredIds).toContain(parked.approvalId);
    expect(expiredIds).toContain(dispatched.approvalId);

    for (const { runId, approvalId } of [parked, dispatched]) {
      const a = await approvalRow(approvalId);
      expect(a.state).toBe('EXPIRED');
      expect(a.decided_at).not.toBeNull();
      expect(a.decision_actor_id).toBe('system:approval-expiry-sweep');
      const r = await runRow(runId);
      expect(r.state).toBe('CANCELED');
      expect(r.terminal_reason).toBe('approval_expired');
      expect(r.finished_at).not.toBeNull();
      expect(await reservationState(runId)).toBe('RELEASED');
      // The denial-path outbox event fires so the run-cancel consumer stops Studio.
      expect(await outboxCanceledCount(runId)).toBe(1);
      // P5-A8: payload must include conversation_id or the run-cancel consumer
      // dead-letters it as malformed and Studio is never told to stop the run.
      const payload = await outboxCanceledPayload(runId);
      expect(payload?.run_id).toBe(runId);
      expect(typeof payload?.conversation_id).toBe('string');
      expect(payload?.reason).toBe('approval_expired');
    }
    // Both advisory holds returned (fail-closed: never auto-approve, quota settled).
    expect(await redisEvents()).toBe(holdsBefore - 2);
  });

  it('leaves non-expired PENDING approvals and decided approvals untouched', async () => {
    const ids = await fixtureIds();
    const fresh = await seedParkedRun(ids, 'WAITING_APPROVAL', 'PENDING', 15);
    const approved = await seedParkedRun(ids, 'WAITING_APPROVAL', 'APPROVED', -20);
    const denied = await seedParkedRun(ids, 'RUNNING', 'DENIED', -20);
    const holdsBefore = await redisEvents();

    const result = await authority.sweepExpiredApprovals({ orgId });
    const expiredIds = result.sweptApprovals.map((e) => e.approvalId);
    expect(expiredIds).not.toContain(fresh.approvalId);
    expect(expiredIds).not.toContain(approved.approvalId);
    expect(expiredIds).not.toContain(denied.approvalId);

    expect((await approvalRow(fresh.approvalId)).state).toBe('PENDING');
    expect((await runRow(fresh.runId)).state).toBe('WAITING_APPROVAL');
    expect(await reservationState(fresh.runId)).toBe('RESERVED');
    expect((await approvalRow(approved.approvalId)).state).toBe('APPROVED');
    expect((await approvalRow(denied.approvalId)).state).toBe('DENIED');
    expect(await redisEvents()).toBe(holdsBefore);
  });

  it('re-sweep is idempotent: nothing re-expires, no duplicate outbox rows', async () => {
    const ids = await fixtureIds();
    const parked = await seedParkedRun(ids, 'WAITING_APPROVAL', 'PENDING', -20);

    const first = await authority.sweepExpiredApprovals({ orgId });
    expect(first.sweptApprovals.map((e) => e.approvalId)).toContain(parked.approvalId);
    const canceledAfterFirst = await outboxCanceledCount(parked.runId);

    const second = await authority.sweepExpiredApprovals({ orgId });
    expect(second.sweptApprovals).toHaveLength(0);
    expect(await outboxCanceledCount(parked.runId)).toBe(canceledAfterFirst);
    expect((await approvalRow(parked.approvalId)).state).toBe('EXPIRED');
  });

  it('marks the approval EXPIRED but leaves an already-terminal run and its quota alone', async () => {
    const ids = await fixtureIds();
    // The user canceled the run while the approval was pending; the cancel
    // path already terminalized the run and settled quota.
    const done = await seedParkedRun(ids, 'CANCELED', 'PENDING', -20);
    await db.withBypass((tx) =>
      tx.execute(sql`update quota_reservations set state = 'RELEASED' where run_id = ${done.runId}::uuid`),
    );
    const canceledBefore = await outboxCanceledCount(done.runId);

    const result = await authority.sweepExpiredApprovals({ orgId });
    expect(result.sweptApprovals.map((e) => e.approvalId)).toContain(done.approvalId);
    expect((await approvalRow(done.approvalId)).state).toBe('EXPIRED');
    // Run untouched (already terminal) and no second run.canceled outbox row.
    expect((await runRow(done.runId)).state).toBe('CANCELED');
    expect(await outboxCanceledCount(done.runId)).toBe(canceledBefore);
  });

  it('expires non-overdue sibling approvals when the sweep terminalizes their run', async () => {
    const ids = await fixtureIds();
    // Run parked with two pending approvals: one overdue, one whose window
    // has NOT elapsed. Pre-fix the sweep canceled the run but left the
    // sibling PENDING — a live approval on a CANCELED run.
    const parked = await seedParkedRun(ids, 'WAITING_APPROVAL', 'PENDING', -20);
    const siblingId = await seedApproval(parked.runId, 'PENDING', 30);

    const result = await authority.sweepExpiredApprovals({ orgId });
    const byId = new Map(result.sweptApprovals.map((e) => [e.approvalId, e]));
    expect(byId.get(parked.approvalId)?.runTerminalized).toBe(true);
    expect(byId.get(siblingId)?.runTerminalized).toBe(true);

    expect((await approvalRow(parked.approvalId)).state).toBe('EXPIRED');
    expect((await approvalRow(siblingId)).state).toBe('EXPIRED');
    expect((await approvalRow(siblingId)).decision_actor_id).toBe('system:approval-expiry-sweep');
    const r = await runRow(parked.runId);
    expect(r.state).toBe('CANCELED');
    expect(r.terminal_reason).toBe('approval_expired');
    expect(await reservationState(parked.runId)).toBe('RELEASED');
    // Exactly one run.canceled outbox row — the sibling expiry is not a
    // second terminalization.
    expect(await outboxCanceledCount(parked.runId)).toBe(1);
  });

  it('decideApproval after expires_at fails closed (never races the sweep)', async () => {
    const ids = await fixtureIds();
    const parked = await seedParkedRun(ids, 'WAITING_APPROVAL', 'PENDING', -20);

    // A late APPROVED must not resume a run the sweep is about to cancel.
    await expect(
      authority.decideApproval({
        orgId,
        runId: parked.runId,
        approvalId: parked.approvalId,
        decision: 'APPROVED',
        actor: 'late-approver',
      }),
    ).rejects.toThrow('approval expired');

    // A late DENIED is rejected the same way — expiry owns the outcome now.
    await expect(
      authority.decideApproval({
        orgId,
        runId: parked.runId,
        approvalId: parked.approvalId,
        decision: 'DENIED',
        actor: 'late-approver',
        reason: 'too late',
      }),
    ).rejects.toThrow('approval expired');

    // Nothing moved: approval still PENDING (the sweep owns the transition),
    // run still parked, quota still held.
    expect((await approvalRow(parked.approvalId)).state).toBe('PENDING');
    expect((await runRow(parked.runId)).state).toBe('WAITING_APPROVAL');
    expect(await reservationState(parked.runId)).toBe('RESERVED');
  });
});
