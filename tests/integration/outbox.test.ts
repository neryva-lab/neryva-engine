import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makePool, TEST_DATABASE_URL } from '../helpers/db';

/**
 * Phase 6 integration — outbox dispatcher, inbox dedup, dead-letter, replay.
 * Uses a recording consumer and a permanently-failing consumer registered on
 * test-only event types; events are inserted with engine_bypass.
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

describeIfDb('outbox dispatcher (requires DATABASE_URL)', () => {
  let pool: import('pg').Pool;
  let dispatcher: import('../../src/common/infra/outbox/dispatcher').OutboxDispatcher;
  let recorded: Array<{ eventId: string; eventType: string }>;
  const orgId = randomUUID();
  const handled: string[] = [];

  beforeAll(async () => {
    process.loadEnvFile('.env');
    pool = makePool();
    const { OutboxDispatcher } = await import('../../src/common/infra/outbox/dispatcher');
    const { DbService } = await import('../../src/common/infra/db/db.service');
    recorded = [];
    const okConsumer = {
      name: 'test-ok',
      eventTypes: ['test.ok'],
      handle: async (event: { eventId: string; eventType: string }) => {
        recorded.push({ eventId: event.eventId, eventType: event.eventType });
      },
    };
    const failConsumer = {
      name: 'test-fail',
      eventTypes: ['test.permanent'],
      handle: async () => {
        const { PermanentConsumerError } = await import('../../src/common/infra/outbox/consumer');
        throw new PermanentConsumerError('always fails');
      },
    };
    const retryConsumer = {
      name: 'test-retry',
      eventTypes: ['test.retry'],
      handle: async (event: { eventId: string }) => {
        if (!handled.includes(event.eventId)) {
          throw new Error('transient failure');
        }
      },
    };
    const db = new DbService();
    dispatcher = new OutboxDispatcher(db, [okConsumer, failConsumer, retryConsumer], { batchSize: 10, maxAttempts: 2, staleClaimMs: 5000 });
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      await client.query(`delete from outbox_events where organization_id = $1::uuid`, [orgId]);
      await client.query(`delete from inbox_events where consumer_name like 'test-%'`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  async function insertEvent(eventType: string): Promise<string> {
    const eventId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      await client.query(
        `insert into outbox_events (event_id, aggregate_type, aggregate_id, organization_id, event_type, partition_key)
         values ($1::uuid, 'test', gen_random_uuid(), $2::uuid, $3, $4::uuid)`,
        [eventId, orgId, eventType, orgId],
      );
    } finally {
      client.release();
    }
    return eventId;
  }

  async function statusOf(eventId: string): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      const res = await client.query(`select status from outbox_events where event_id = $1::uuid`, [eventId]);
      return res.rows[0]?.status ?? 'missing';
    } finally {
      client.release();
    }
  }

  it('publishes to registered consumers and records inbox dedup', async () => {
    const eventId = await insertEvent('test.ok');
    await dispatcher.tick();
    expect(await statusOf(eventId)).toBe('PUBLISHED');
    expect(recorded.filter((r) => r.eventId === eventId)).toHaveLength(1);

    // Redelivery of the same event skips the consumer (inbox PROCESSED).
    const client = await pool.connect();
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    await client.query(`update outbox_events set status='PENDING', next_attempt_at=now() where event_id=$1::uuid`, [eventId]);
    client.release();
    await dispatcher.tick();
    expect(recorded.filter((r) => r.eventId === eventId)).toHaveLength(1); // still once
  });

  it('dead-letters permanent consumer failures immediately', async () => {
    const eventId = await insertEvent('test.permanent');
    await dispatcher.tick();
    expect(await statusOf(eventId)).toBe('DEAD_LETTER');
  });

  it('retries transient failures with backoff, then completes', async () => {
    const eventId = await insertEvent('test.retry');
    await dispatcher.tick();
    expect(await statusOf(eventId)).toBe('RETRY_WAIT');

    // Force next_attempt_at now; the consumer succeeds on the retry.
    const client = await pool.connect();
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    handled.push(eventId);
    await client.query(`update outbox_events set next_attempt_at=now() where event_id=$1::uuid`, [eventId]);
    client.release();
    await dispatcher.tick();
    expect(await statusOf(eventId)).toBe('PUBLISHED');
  });

  it('replays dead-lettered events on operator command', async () => {
    const eventId = await insertEvent('test.permanent');
    await dispatcher.tick();
    expect(await statusOf(eventId)).toBe('DEAD_LETTER');
    const replayed = await dispatcher.replayDeadLetter(eventId);
    expect(replayed).toBe(true);
    expect(await statusOf(eventId)).toBe('PENDING');
  });
});
