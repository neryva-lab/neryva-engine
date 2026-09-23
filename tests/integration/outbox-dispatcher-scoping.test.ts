import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool, withBypassRaw, TEST_DATABASE_URL } from '../helpers/db';

/**
 * Regression: OutboxDispatcher.claimBatch() must only claim events whose
 * event_type is handled by a consumer registered on THAT dispatcher
 * instance. Previously claimBatch claimed every PENDING/RETRY_WAIT row
 * DB-wide (FOR UPDATE SKIP LOCKED, no event_type filter) and publishOne()
 * then marked rows with no matching consumer PUBLISHED without delivering
 * them — silently losing events when two dispatcher instances (or two
 * parallel integration suites) shared one database.
 *
 * This file: two dispatcher instances with DISJOINT consumer sets against
 * the same DB. Each dispatcher's events must be delivered exactly once to
 * its own consumers; the other type's rows must stay PENDING until the
 * right dispatcher runs.
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

describeIfDb('outbox dispatcher claim scoping (requires DATABASE_URL)', () => {
  let pool: import('pg').Pool;
  let dispatcherA: import('../../src/common/infra/outbox/dispatcher').OutboxDispatcher;
  let dispatcherB: import('../../src/common/infra/outbox/dispatcher').OutboxDispatcher;
  let dispatcherWildcard: import('../../src/common/infra/outbox/dispatcher').OutboxDispatcher;
  let dispatcherEmpty: import('../../src/common/infra/outbox/dispatcher').OutboxDispatcher;
  const orgId = randomUUID();
  const deliveredA: string[] = [];
  const deliveredB: string[] = [];
  const deliveredWildcard: string[] = [];

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    pool = makePool();
    const { OutboxDispatcher } = await import('../../src/common/infra/outbox/dispatcher');
    const { DbService } = await import('../../src/common/infra/db/db.service');
    const db = new DbService();
    const mkConsumer = (name: string, eventTypes: string[], sink: string[]) => ({
      name,
      eventTypes,
      handle: async (event: { eventId: string }) => {
        sink.push(event.eventId);
      },
    });
    dispatcherA = new OutboxDispatcher(db, [mkConsumer('scope-a', ['test.scope.a'], deliveredA)], { batchSize: 10, staleClaimMs: 5000 });
    dispatcherB = new OutboxDispatcher(db, [mkConsumer('scope-b', ['test.scope.b'], deliveredB)], { batchSize: 10, staleClaimMs: 5000 });
    dispatcherWildcard = new OutboxDispatcher(db, [mkConsumer('scope-wild', ['*'], deliveredWildcard)], { batchSize: 10, staleClaimMs: 5000 });
    dispatcherEmpty = new OutboxDispatcher(db, [], { batchSize: 10, staleClaimMs: 5000 });
  });

  afterAll(async () => {
    await withBypassRaw(pool, async (client) => {
      await client.query(`delete from outbox_events where organization_id = $1::uuid`, [orgId]);
      await client.query(`delete from inbox_events where consumer_name like 'scope-%'`);
    });
    await pool.end();
  });

  async function insertEvent(eventType: string): Promise<string> {
    const eventId = randomUUID();
    await withBypassRaw(pool, async (client) => {
      await client.query(
        `insert into outbox_events (event_id, aggregate_type, aggregate_id, organization_id, event_type, partition_key)
         values ($1::uuid, 'test', gen_random_uuid(), $2::uuid, $3, $4::uuid)`,
        [eventId, orgId, eventType, orgId],
      );
    });
    return eventId;
  }

  async function statusOf(eventId: string): Promise<string> {
    let status = 'missing';
    await withBypassRaw(pool, async (client) => {
      const res = await client.query(`select status from outbox_events where event_id = $1::uuid`, [eventId]);
      status = (res.rows[0] as { status?: string } | undefined)?.status ?? 'missing';
    });
    return status;
  }

  it('delivers each type exactly once to the dispatcher that owns it; the other type stays PENDING', async () => {
    const eventA = await insertEvent('test.scope.a');
    const eventB = await insertEvent('test.scope.b');

    // Dispatcher A owns only test.scope.a.
    const resA = await dispatcherA.tick();
    expect(resA.published).toBe(1);
    expect(deliveredA).toEqual([eventA]);
    expect(deliveredB).toEqual([]);
    expect(await statusOf(eventA)).toBe('PUBLISHED');
    // The foreign event type must NOT be claimed or marked PUBLISHED.
    expect(await statusOf(eventB)).toBe('PENDING');

    // Dispatcher B now picks up its own event exactly once.
    const resB = await dispatcherB.tick();
    expect(resB.published).toBe(1);
    expect(deliveredB).toEqual([eventB]);
    expect(await statusOf(eventB)).toBe('PUBLISHED');
  });

  it('wildcard consumer still claims all types (backward compatibility)', async () => {
    const eventA = await insertEvent('test.scope.a');
    const eventB = await insertEvent('test.scope.b');
    const res = await dispatcherWildcard.tick();
    expect(res.published).toBe(2);
    expect(deliveredWildcard).toEqual(expect.arrayContaining([eventA, eventB]));
    expect(await statusOf(eventA)).toBe('PUBLISHED');
    expect(await statusOf(eventB)).toBe('PUBLISHED');
  });

  it('dispatcher with no consumers claims nothing', async () => {
    const eventA = await insertEvent('test.scope.a');
    const res = await dispatcherEmpty.tick();
    expect(res.claimed).toBe(0);
    expect(res.published).toBe(0);
    expect(await statusOf(eventA)).toBe('PENDING');

    // Cleanup for the next tests in this file: dispatcher A delivers it.
    await dispatcherA.tick();
    expect(await statusOf(eventA)).toBe('PUBLISHED');
  });
});
