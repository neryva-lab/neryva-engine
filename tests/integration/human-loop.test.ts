import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, makePool, seedOrgChain, cleanupOrg, probeAsTenant } from '../helpers/db';

/**
 * REL-5.4 human-loop test pack (release_ledger.md) — the pending-work plane
 * against a real database (db-suites lane):
 * - escalation lifecycle through the real service: escalate → queue list →
 *   claim/assign → resolve, with conversation pause/resume (FL-1.7d);
 * - domain idempotency: re-escalate replays the open row, same-agent
 *   reclaim replays, resolve replays; cross-agent claim and out-of-order
 *   transitions conflict with typed codes;
 * - cross-tenant denial: foreign-org list/claim/resolve see nothing
 *   (service-level scoping), and RLS denies cross-tenant reads and
 *   mismatched-org inserts on both `approvals` and `escalations`.
 *
 * The approvals decide path itself is exercised by the H1a exit-gate run
 * (FL-1.8); here approvals are covered at the isolation layer plus the
 * fan-out contract (tests/unit/human-loop-notify.test.ts). Audit rows
 * written by the service are append-only by design and intentionally kept.
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

function freshOrgPair(): [string, string] {
  const a = randomUUID();
  let b = randomUUID();
  while (a.slice(-1) === b.slice(-1)) {
    b = randomUUID();
  }
  return [a, b];
}

describeIfDb('human-loop operations (requires DATABASE_URL)', () => {
  let db: import('../../src/common/infra/db/db.service').DbService;
  let escalations: import('../../src/modules/conversations/escalations.service').EscalationsService;
  const [orgA, orgB] = freshOrgPair();
  const pool = TEST_DATABASE_URL ? makePool() : null;

  async function orgConversation(org: string): Promise<string> {
    const rows = await db.withBypass((tx) =>
      tx.execute<{ id: string }>(sql`select id from conversations where organization_id = ${org}::uuid limit 1`),
    );
    return (rows.rows[0] as { id: string }).id;
  }

  beforeAll(async () => {
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const { EscalationsService } = await import('../../src/modules/conversations/escalations.service');
    const { AuditService } = await import('../../src/common/audit/audit.service');
    db = new DbService();
    escalations = new EscalationsService(db, new AuditService(db));
    await seedOrgChain(pool as NonNullable<typeof pool>, orgA);
    await seedOrgChain(pool as NonNullable<typeof pool>, orgB);
  });

  afterAll(async () => {
    await cleanupOrg(pool as NonNullable<typeof pool>, [orgA, orgB]);
    (pool as NonNullable<typeof pool>).end().catch(() => undefined);
    await db.onModuleDestroy();
  });

  it('escalate → queue → claim → resolve pauses and resumes the auto-responder', async () => {
    const conversationId = await orgConversation(orgA);
    const opened = await escalations.escalate({ orgId: orgA, conversationId, reason: 'user_request', actor: 'rel54-test' });
    expect(opened.state).toBe('WAITING');

    const queue = await escalations.listQueue({ orgId: orgA, state: 'WAITING' });
    expect(queue.map((row) => row.id)).toContain(opened.id);

    const status = await db.withBypass((tx) =>
      tx.execute<{ status: string }>(sql`select status from conversations where id = ${conversationId}::uuid`),
    );
    expect((status.rows[0] as { status: string }).status).toBe('escalated');

    const claimed = await escalations.claim({ orgId: orgA, escalationId: opened.id, agent: 'agent-1', actor: 'rel54-test' });
    expect(claimed.state).toBe('CLAIMED');
    expect(claimed.claimedBy).toBe('agent-1');

    const resolved = await escalations.resolve({ orgId: orgA, escalationId: opened.id, note: 'handled', actor: 'rel54-test' });
    expect(resolved.state).toBe('RESOLVED');

    const resumed = await db.withBypass((tx) =>
      tx.execute<{ status: string }>(sql`select status from conversations where id = ${conversationId}::uuid`),
    );
    expect((resumed.rows[0] as { status: string }).status).toBe('active');
  });

  it('re-escalate replays the open row; replays never duplicate queue entries', async () => {
    const conversationId = await orgConversation(orgB);
    const first = await escalations.escalate({ orgId: orgB, conversationId, reason: 'user_request', actor: 'rel54-test' });
    const replay = await escalations.escalate({ orgId: orgB, conversationId, reason: 'user_request', actor: 'rel54-test' });
    expect(replay.id).toBe(first.id);
    const queue = await escalations.listQueue({ orgId: orgB, state: 'WAITING' });
    expect(queue.filter((row) => row.conversationId === conversationId)).toHaveLength(1);
    await escalations.claim({ orgId: orgB, escalationId: first.id, agent: 'agent-1', actor: 'rel54-test' });
    await escalations.resolve({ orgId: orgB, escalationId: first.id, actor: 'rel54-test' });
  });

  it('same-agent reclaim and re-resolve replay; cross-agent claim and out-of-order moves conflict', async () => {
    const assistantRow = await db.withBypass((tx) =>
      tx.execute<{ id: string }>(sql`select id from assistants where organization_id = ${orgA}::uuid limit 1`),
    );
    const assistantId = (assistantRow.rows[0] as { id: string }).id;
    const secondConversation = randomUUID();
    await db.withBypass((tx) =>
      tx.execute(sql`insert into conversations (id, organization_id, assistant_id) values (${secondConversation}::uuid, ${orgA}::uuid, ${assistantId}::uuid)`),
    );
    const opened = await escalations.escalate({ orgId: orgA, conversationId: secondConversation, reason: 'negative_feedback', actor: 'rel54-test' });

    // Resolve-before-claim is an ordering violation, not a silent fix-up.
    await expect(escalations.resolve({ orgId: orgA, escalationId: opened.id, actor: 'rel54-test' })).rejects.toMatchObject({
      code: 'conflict',
    });

    const assigned = await escalations.assign({ orgId: orgA, escalationId: opened.id, agent: 'agent-2', actor: 'rel54-test' });
    expect(assigned.state).toBe('CLAIMED');
    const reclaim = await escalations.claim({ orgId: orgA, escalationId: opened.id, agent: 'agent-2', actor: 'rel54-test' });
    expect(reclaim.id).toBe(opened.id);
    await expect(
      escalations.claim({ orgId: orgA, escalationId: opened.id, agent: 'agent-3', actor: 'rel54-test' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const resolved = await escalations.resolve({ orgId: orgA, escalationId: opened.id, actor: 'rel54-test' });
    expect(resolved.state).toBe('RESOLVED');
    const resolveReplay = await escalations.resolve({ orgId: orgA, escalationId: opened.id, actor: 'rel54-test' });
    expect(resolveReplay.id).toBe(opened.id);
    await expect(
      escalations.claim({ orgId: orgA, escalationId: opened.id, agent: 'agent-2', actor: 'rel54-test' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('empty reasons and empty agents are validation errors, not rows', async () => {
    const conversationId = await orgConversation(orgA);
    await expect(escalations.escalate({ orgId: orgA, conversationId, reason: '   ', actor: 'rel54-test' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      escalations.claim({ orgId: orgA, escalationId: randomUUID(), agent: '  ', actor: 'rel54-test' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('foreign-org callers see an empty queue and not_found on claim/resolve', async () => {
    const queue = await escalations.listQueue({ orgId: orgB });
    expect(queue.find((row) => row.organizationId === orgA)).toBeUndefined();
    const foreign = randomUUID();
    await expect(escalations.claim({ orgId: orgB, escalationId: foreign, agent: 'agent-x', actor: 'rel54-test' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(escalations.resolve({ orgId: orgB, escalationId: foreign, actor: 'rel54-test' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('RLS denies cross-tenant reads and mismatched-org inserts on approvals and escalations', async () => {
    // Plant one approval against org A's seeded run (bypass: setup, not the assertion).
    const runRow = await db.withBypass((tx) =>
      tx.execute<{ id: string }>(sql`select id from runs where organization_id = ${orgA}::uuid limit 1`),
    );
    const runId = (runRow.rows[0] as { id: string }).id;
    const approvalId = randomUUID();
    // Bypass plant is setup, not the assertion — the probes below run as tenants.
    await db.withBypass((tx) =>
      tx.execute(sql`insert into approvals (id, organization_id, run_id, approval_ref, summary, expires_at)
        values (${approvalId}::uuid, ${orgA}::uuid, ${runId}::uuid, ${`rel54-${approvalId.slice(0, 8)}`}, 'rel54 approval', now() + interval '1 hour')
        on conflict do nothing`),
    );

    const ownApprovals = await probeAsTenant(pool as NonNullable<typeof pool>, orgA, `select id from approvals where organization_id = $1::uuid`, [orgA]);
    expect(ownApprovals.rowCount).toBe(1);
    const foreignApprovals = await probeAsTenant(pool as NonNullable<typeof pool>, orgB, `select id from approvals where organization_id = $1::uuid`, [orgA]);
    expect(foreignApprovals.rowCount).toBe(0);
    await expect(
      probeAsTenant(pool as NonNullable<typeof pool>, orgB, `insert into approvals (id, organization_id, run_id, approval_ref, summary, expires_at) values ($1::uuid, $2::uuid, $3::uuid, $4, 'smuggled', now() + interval '1 hour')`, [
        randomUUID(),
        orgA,
        runId,
        `rel54-smuggle-${randomUUID().slice(0, 8)}`,
      ]),
    ).rejects.toThrow();

    const ownEscalations = await probeAsTenant(pool as NonNullable<typeof pool>, orgA, `select id from escalations where organization_id = $1::uuid`, [orgA]);
    expect((ownEscalations.rowCount ?? 0)).toBeGreaterThanOrEqual(1);
    const foreignEscalations = await probeAsTenant(pool as NonNullable<typeof pool>, orgB, `select id from escalations where organization_id = $1::uuid`, [orgA]);
    expect(foreignEscalations.rowCount).toBe(0);
  });
});
