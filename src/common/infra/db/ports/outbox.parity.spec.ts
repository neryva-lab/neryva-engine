import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { inboxEvents, outboxEvents } from '../../outbox/schema';
import { uuidv7 } from '../../../ids/uuidv7';
import { runMongoMigrations } from '../mongo/migrations/mongo-migrator';
import { uuidToBinary } from '../mongo/mongo-tx';
import {
  MongoInboxStore,
  MongoOutboxStore,
  PgInboxStore,
  PgOutboxStore,
  type IInboxStore,
  type IOutboxStore,
  type OutboxEventInput,
} from './outbox';

/**
 * Behavioral parity spec for the Outbox/Inbox port — P2 proof gate (plan D10).
 *
 * Every scenario runs against BOTH providers:
 * - pg lane: real PostgreSQL (DATABASE_URL, same default as tests/setup-unit.ts)
 * - mongo lane: mongodb-memory-server, single-node replica set
 *
 * Scenarios: append→claim→publish lifecycle; FIFO order; N concurrent
 * claimers × M events with exactly-once claims (the race test); stale-claim
 * recovery; retry/dead-letter transitions; inbox double-claim → duplicate.
 *
 * Not run during iteration (user directive) — run once explicitly:
 *   pnpm vitest run src/common/infra/db/ports/outbox.parity.spec.ts
 */

interface LaneStores {
  outbox: IOutboxStore;
  inbox: IInboxStore;
}

interface Lane {
  withStore<T>(orgId: string, fn: (s: LaneStores) => Promise<T>): Promise<T>;
  /**
   * Remove every row this parity suite created (identified by the `parity:`
   * partition-key / `parity-` consumer-name tags). Dispatcher operations are
   * global by design, so each test starts from an empty parity slate —
   * otherwise one test's leftover CLAIMED rows would be visible to the next
   * test's wildcard claimBatch / recoverStaleClaims.
   */
  purge(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeInput(orgId: string, overrides?: Partial<OutboxEventInput>): OutboxEventInput {
  return {
    aggregateType: 'run',
    aggregateId: uuidv7(),
    organizationId: orgId,
    eventType: 'run.completed',
    // `parity:` tag: lets purge() identify this suite's rows without
    // touching real tenants' outbox data in the shared dev database.
    partitionKey: `parity:${uuidv7()}`,
    payload: { ok: true },
    ...overrides,
  };
}

// ─── pg lane ─────────────────────────────────────────────────────────────────

let pgPool: Pool;
let pgDb: ReturnType<typeof drizzle>;

async function pgWithStore<T>(orgId: string, fn: (s: LaneStores) => Promise<T>): Promise<T> {
  // Mirrors DbService.withBypass: the dispatch-plane operations run without a
  // tenant context (RLS bypass), exactly as OutboxDispatcher does. `append`
  // carries organization_id explicitly in the row.
  return pgDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.engine_bypass = 'on'`);
    // Same intent as DbService.withBypass's `tx as NodePgDatabase`; the extra
    // `unknown` step satisfies the compiler's overlap check for the inferred
    // transaction type.
    const db = tx as unknown as NodePgDatabase;
    return fn({ outbox: new PgOutboxStore(db), inbox: new PgInboxStore(db) });
  });
}

async function pgPurge(): Promise<void> {
  await pgDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.engine_bypass = 'on'`);
    const db = tx as unknown as NodePgDatabase;
    await db.delete(outboxEvents).where(sql`${outboxEvents.partitionKey} LIKE 'parity:%'`);
    await db.delete(inboxEvents).where(sql`${inboxEvents.consumerName} LIKE 'parity-%'`);
  });
}

const pgLane: Lane = { withStore: pgWithStore, purge: pgPurge };

// ─── mongo lane ──────────────────────────────────────────────────────────────

let replSet: MongoMemoryReplSet;
let mongoClient: MongoClient;
let mongoDb: Db;

async function mongoWithStore<T>(orgId: string, fn: (s: LaneStores) => Promise<T>): Promise<T> {
  const session = mongoClient.startSession();
  try {
    return await fn({
      outbox: new MongoOutboxStore(mongoDb, { session, orgId }),
      inbox: new MongoInboxStore(mongoDb, { session, orgId: null }),
    });
  } finally {
    await session.endSession();
  }
}

async function mongoPurge(): Promise<void> {
  // In-memory database is dedicated to this suite: full wipe is safe.
  await mongoDb.collection('outbox_events').deleteMany({});
  await mongoDb.collection('inbox_events').deleteMany({});
}

const mongoLane: Lane = { withStore: mongoWithStore, purge: mongoPurge };

// ─── shared scenarios ────────────────────────────────────────────────────────

function defineOutboxParitySuite(laneName: string, lane: Lane) {
  describe(`outbox/inbox parity [${laneName}]`, () => {
    const orgId = uuidv7();
    const consumerPrefix = `parity-${laneName}-${uuidv7().slice(0, 8)}`;

    // Dispatcher operations are global (cross-tenant) by design, so every
    // test starts from an empty parity slate; otherwise leftover CLAIMED
    // rows from an earlier test would leak into wildcard claimBatch /
    // recoverStaleClaims assertions.
    beforeEach(async () => {
      await lane.purge();
    });

    afterAll(async () => {
      await lane.purge();
    });

    it('append → claim → publish lifecycle', async () => {
      await lane.withStore(orgId, async ({ outbox }) => {
        const appended = await outbox.append(makeInput(orgId));
        expect(appended.status).toBe('PENDING');
        expect(appended.organizationId).toBe(orgId);
        expect(appended.attemptCount).toBe(0);

        const claimed = await outbox.claimBatch(10);
        expect(claimed.map((e) => e.eventId)).toContain(appended.eventId);

        await outbox.markPublished(appended.eventId);
        expect(await outbox.claimBatch(10)).toHaveLength(0);
      });
    });

    it('FIFO order preserved across claimBatch', async () => {
      // One store (one tx/session) per append: pg's now() is transaction-start
      // time, so same-tx appends share created_at and the order would be
      // tie-broken — real appends happen in their own fact transactions.
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        await lane.withStore(orgId, async ({ outbox }) => {
          const e = await outbox.append(makeInput(orgId, { eventType: `fifo.${i}` }));
          ids.push(e.eventId);
        });
        await sleep(10);
      }
      await lane.withStore(orgId, async ({ outbox }) => {
        const claimed = await outbox.claimBatch(100);
        expect(claimed.map((e) => e.eventId)).toEqual(ids);
      });
    });

    it(
      'concurrent claimers: each event claimed exactly once',
      { timeout: 60_000 },
      async () => {
          const M = 40;
        const seeders = 4;
        await Promise.all(
          Array.from({ length: seeders }, () =>
            lane.withStore(orgId, async ({ outbox }) => {
              for (let i = 0; i < M / seeders; i++) {
                await outbox.append(makeInput(orgId));
              }
            }),
          ),
        );

        const seen = new Set<string>();
        const workers = 8;
        await Promise.all(
          Array.from({ length: workers }, () =>
            lane.withStore(orgId, async ({ outbox }) => {
              for (;;) {
                const batch = await outbox.claimBatch(5);
                if (batch.length === 0) break;
                for (const e of batch) {
                  if (seen.has(e.eventId)) {
                    throw new Error(`double-claimed event ${e.eventId}`);
                  }
                  seen.add(e.eventId);
                }
              }
            }),
          ),
        );
        expect(seen.size).toBe(M);
      },
    );

    it('stale-claim recovery returns crashed-worker rows to PENDING', async () => {
      await lane.withStore(orgId, async ({ outbox }) => {
        const e = await outbox.append(makeInput(orgId));
        expect(await outbox.claimBatch(10)).toHaveLength(1);

        // Fresh claim: a long lease recovers nothing.
        expect(await outbox.recoverStaleClaims(3_600_000)).toBe(0);
        expect(await outbox.claimBatch(10)).toHaveLength(0);

        // Zero lease: every CLAIMED row is stale → recovered to PENDING.
        expect(await outbox.recoverStaleClaims(0)).toBe(1);
        const reclaimed = await outbox.claimBatch(10);
        expect(reclaimed.map((x) => x.eventId)).toEqual([e.eventId]);
      });
    });

    it('retry and dead-letter transitions', async () => {
      await lane.withStore(orgId, async ({ outbox }) => {
        const e = await outbox.append(makeInput(orgId));
        expect(await outbox.claimBatch(10)).toHaveLength(1);

        // Retryable failure: RETRY_WAIT with a future next_attempt_at is not claimable…
        const attempt = await outbox.markFailed(e.eventId, 'boom', new Date(Date.now() + 60_000));
        expect(attempt).toBe(1);
        expect(await outbox.claimBatch(10)).toHaveLength(0);

        // …but becomes claimable once due (attempt count keeps incrementing).
        const attempt2 = await outbox.markFailed(e.eventId, 'boom again', new Date(Date.now() - 1000));
        expect(attempt2).toBe(2);
        const redelivered = await outbox.claimBatch(10);
        expect(redelivered.map((x) => x.eventId)).toEqual([e.eventId]);

        // Dead-letter: never claimed again.
        await outbox.moveToDeadLetter(e.eventId, 'fatal', 8);
        expect(await outbox.claimBatch(10)).toHaveLength(0);
        expect(await outbox.recoverStaleClaims(0)).toBe(0);
      });
    });

    it('claimBatch with empty eventTypes claims nothing (fail closed)', async () => {
      await lane.withStore(orgId, async ({ outbox }) => {
        await outbox.append(makeInput(orgId));
        expect(await outbox.claimBatch(10, { eventTypes: [] })).toHaveLength(0);
        // …and the row is still there for a wildcard claim.
        expect(await outbox.claimBatch(10)).toHaveLength(1);
      });
    });

    it('inbox: double-claim is a duplicate; failed claims are reclaimable', async () => {
      await lane.withStore(orgId, async ({ inbox }) => {
        const key = { consumerName: `${consumerPrefix}-c1`, eventId: uuidv7() };
        expect(await inbox.tryClaim(key)).toBe(true);
        expect(await inbox.tryClaim(key)).toBe(false); // duplicate

        await inbox.complete(key, { ok: true });
        expect(await inbox.tryClaim(key)).toBe(false); // PROCESSED skips forever

        const failed = { consumerName: `${consumerPrefix}-c1`, eventId: uuidv7() };
        expect(await inbox.tryClaim(failed)).toBe(true);
        await inbox.fail(failed, 'handler exploded');
        expect(await inbox.tryClaim(failed)).toBe(true); // FAILED is reclaimable

        const stale = { consumerName: `${consumerPrefix}-c1`, eventId: uuidv7() };
        expect(await inbox.tryClaim(stale)).toBe(true);
        expect(await inbox.tryClaim(stale, { staleMs: 0 })).toBe(true); // stale PROCESSING reclaimed
        expect(await inbox.tryClaim(stale)).toBe(false); // fresh PROCESSING is busy
      });
    });
  });
}

// ─── lane setup ──────────────────────────────────────────────────────────────

/**
 * Idempotent DDL for the parity database, mirrored from
 * drizzle/0023_async_foundation.sql and drizzle/0025_outbox_dispatch.sql.
 * (The parity DB is dedicated to this suite, so the tables are provisioned
 * here instead of via the release-job migrations.)
 */
async function ensureOutboxTables(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "outbox_events" (
      "event_id" uuid PRIMARY KEY,
      "aggregate_type" varchar(64) NOT NULL,
      "aggregate_id" uuid NOT NULL,
      "organization_id" uuid NOT NULL,
      "event_type" varchar(64) NOT NULL,
      "event_version" integer NOT NULL DEFAULT 1,
      "payload" jsonb,
      "partition_key" varchar(128) NOT NULL,
      "status" varchar(32) NOT NULL DEFAULT 'PENDING',
      "attempt_count" integer NOT NULL DEFAULT 0,
      "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
      "trace_id" varchar(64),
      "correlation_id" uuid,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "published_at" timestamptz,
      "claimed_at" timestamptz,
      "last_error" text,
      CONSTRAINT "chk_outbox_status" CHECK (status IN ('PENDING','CLAIMED','PUBLISHED','RETRY_WAIT','DEAD_LETTER'))
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "inbox_events" (
      "consumer_name" varchar(128) NOT NULL,
      "event_id" uuid NOT NULL,
      "status" varchar(32) NOT NULL DEFAULT 'RECEIVED',
      "first_received_at" timestamptz NOT NULL DEFAULT now(),
      "last_received_at" timestamptz NOT NULL DEFAULT now(),
      "processed_at" timestamptz,
      "result_ref" jsonb,
      "last_error" text,
      PRIMARY KEY ("consumer_name", "event_id"),
      CONSTRAINT "chk_inbox_status" CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED'))
    )`);
  // RLS matches the CURRENT hardened shape (drizzle/0060_rls_empty_tenant_guard.sql).
  // The nullif(..., '') guard matters: 0023's bare current_setting(...)::uuid
  // throws 22P02 on the '' placeholder that withBypass legitimately sets.
  // The lane itself runs under engine_bypass like the real dispatcher, so the
  // predicate is inert here — but the table shape stays faithful.
  await db.execute(sql`ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY`);
  await db.execute(sql`ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY`);
  await db.execute(sql`DROP POLICY IF EXISTS "outbox_events_tenant_isolation" ON "outbox_events"`);
  await db.execute(sql`
    CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
      USING (organization_id = (nullif(current_setting('app.current_tenant', true), ''))::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
      WITH CHECK (organization_id = (nullif(current_setting('app.current_tenant', true), ''))::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')`);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "ix_outbox_dispatch" ON "outbox_events" ("status", "next_attempt_at") WHERE status IN ('PENDING','RETRY_WAIT')`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "ix_outbox_org_created" ON "outbox_events" USING btree ("organization_id", "created_at")`,
  );
}

/**
 * Resolve the pg lane's database: TEST_DATABASE_URL when set (sibling parity
 * specs' pattern), otherwise a dedicated `neryva_parity` database derived
 * from DATABASE_URL and created on demand. A dedicated database — never the
 * shared dev database — because dispatcher operations (claimBatch,
 * recoverStaleClaims) are global by design and the suite must not see or
 * mutate other tenants' rows.
 */
async function resolvePgUrl(): Promise<string> {
  const override = process.env.TEST_DATABASE_URL;
  if (override) return override;
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is not set — pg parity lane needs a real PostgreSQL');
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const { rowCount } = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = 'neryva_parity'`);
    if (rowCount === 0) await adminPool.query(`CREATE DATABASE "neryva_parity"`);
  } finally {
    await adminPool.end();
  }
  const u = new URL(adminUrl);
  u.pathname = '/neryva_parity';
  return u.toString();
}

beforeAll(async () => {
  const url = await resolvePgUrl();
  pgPool = new Pool({ connectionString: url, max: 10 });
  pgDb = drizzle(pgPool);
  await ensureOutboxTables(pgDb as unknown as NodePgDatabase);
  await pgDb.execute(sql`select 1`);
}, 60_000);

afterAll(async () => {
  await pgPool?.end();
  await mongoClient?.close();
  await replSet?.stop();
});

describe('outbox/inbox port parity', () => {
  describe('mongo lane bootstrap', () => {
    it(
      'starts single-node replica set and provisions collections',
      { timeout: 120_000 },
      async () => {
        // Disk-backed TMPDIR (never /tmp — /tmp is a 512MB tmpfs; /dev/shm is
        // worse). Parent runs with TMPDIR=/home/hatch/tmp; pid suffix keeps
        // concurrent runs from colliding. Wiped per run: a reused dbPath
        // keeps the previous replica-set config (old ports), which breaks
        // replset re-initiation.
        const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-mongo-parity-${process.pid}`;
        await rm(dbPath, { recursive: true, force: true });
        await mkdir(dbPath, { recursive: true });
        replSet = await MongoMemoryReplSet.create({
          replSet: { count: 1, storageEngine: 'wiredTiger' },
          instanceOpts: [{ dbPath }],
        });
        mongoClient = new MongoClient(replSet.getUri());
        await mongoClient.connect();
        mongoDb = mongoClient.db('parity');
        await runMongoMigrations(mongoDb);
        const names = (await mongoDb.listCollections().toArray()).map((c) => c.name);
        expect(names).toContain('outbox_events');
        expect(names).toContain('inbox_events');
      },
    );
  });

  defineOutboxParitySuite('pg', pgLane);
  defineOutboxParitySuite('mongo', mongoLane);

  // Plan D4/D6 sanity: the mongo lane stores UUIDs as BSON Binary subtype 4,
  // and a raw tenant-predicated read for another org sees nothing.
  it('mongo lane stores Binary-subtype-4 UUIDs and isolates tenants', async () => {
    const orgA = uuidv7();
    const orgB = uuidv7();
    await mongoWithStore(orgA, async ({ outbox }) => {
      await outbox.append(makeInput(orgA));
    });
    const raw = await mongoDb.collection('outbox_events').findOne({});
    expect(raw?.['event_id']?.sub_type).toBe(4);
    expect(raw?.['organization_id']?.sub_type).toBe(4);

    const coll = mongoDb.collection('outbox_events');
    expect(await coll.countDocuments({ organization_id: uuidToBinary(orgA) })).toBe(1);
    expect(await coll.countDocuments({ organization_id: uuidToBinary(orgB) })).toBe(0);

    await coll.deleteMany({});
  });
});
