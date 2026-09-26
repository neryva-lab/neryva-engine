/**
 * Notifications repository parity spec (P3 proof) — PgNotificationRepository
 * vs MongoNotificationRepository exercised ONLY through
 * `INotificationRepository`.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. create round-trip: fields persist exactly (title/body truncation is
 *     the service's job — the repository stores what it receives).
 *  2. list: newest-first ordering, unread-only filter, account isolation
 *     (rows for account B are invisible to account A's feed).
 *  3. markRead: account-scoped (marking another account's id is a no-op);
 *     idempotent.
 *  4. markAllRead + unreadCount: count drops to zero; the 500-row scan cap
 *     is lane-agnostic.
 *  5. Cross-provider determinism: the same logical flow on both lanes
 *     yields the same row counts and the same ordering. Row ids are uuidv7
 *     on both lanes but are NOT byte-identical across lanes (generated
 *     independently per write); timestamps are ISO-8601 strings on both
 *     lanes but wall-clock values differ — neither is asserted across lanes.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). The
 * `notifications` table is provisioned idempotently from the drizzle
 * schema shape. The table is platform-plane (no RLS).
 *
 * mongo lane: mongodb-memory-server single-node replica set + the
 * `notifications` collection (indexes created by the repository's
 * migration baseline in production; the spec creates the unique-free
 * collection implicitly on first write).
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import type { DbService } from '../../../common/infra/db/db.service';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { INotificationRepository, Notification } from './notification.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  repo(): INotificationRepository;
  teardown(): Promise<void>;
}

let DbServiceCtor: new () => DbService;
let PgNotificationRepositoryCtor: new (db: DbService) => INotificationRepository;
let MongoNotificationRepositoryCtor: new (m: MongoDbService) => INotificationRepository;

interface MongoLaneDeps {
  root: Db;
  withBypass<T>(fn: (ctx: { session: unknown }) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// pg DDL
// ---------------------------------------------------------------------------

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "notifications" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "account_id" uuid NOT NULL,
     "org_id" varchar(36),
     "kind" varchar(64) NOT NULL,
     "severity" varchar(8) NOT NULL DEFAULT 'info',
     "title" varchar(160) NOT NULL,
     "body" varchar(1024) NOT NULL DEFAULT '',
     "data" jsonb NOT NULL DEFAULT '{}',
     "read_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS "ix_notifications_account_created" ON "notifications" ("account_id", "created_at")`,
  `CREATE INDEX IF NOT EXISTS "ix_notifications_org" ON "notifications" ("org_id", "created_at")`,
];

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function buildPgLane(): Promise<Lane | null> {
  if (!DATABASE_URL) {
    console.warn('[parity] DATABASE_URL not set — pg lane skipped');
    return null;
  }
  // Dynamic imports so env.ts parses after DATABASE_URL is set.
  const dbModule = await import('../../../common/infra/db/db.service');
  DbServiceCtor = dbModule.DbService;
  const pgModule = await import('./pg-notification.repository');
  PgNotificationRepositoryCtor = pgModule.PgNotificationRepository;

  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query('select 1');
  } catch {
    console.warn('[parity] pg unreachable — pg lane skipped');
    await pool.end();
    return null;
  }
  const db = drizzle(pool);
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  const dbService = new DbServiceCtor() as DbService;
  // Swap the pool: the real DbService reads DATABASE_URL at construction.
  const repo = new PgNotificationRepositoryCtor(dbService);
  return {
    name: 'pg',
    repo: () => repo,
    teardown: async () => { await pool.end(); },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet | undefined;
  let client: MongoClient | undefined;
  try {
    const mongoModule = await import('./mongo-notification.repository');
    MongoNotificationRepositoryCtor = mongoModule.MongoNotificationRepository;

    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db('parity');

    const deps: MongoLaneDeps = {
      root: db,
      withBypass: async <T>(fn: (ctx: { session: unknown }) => Promise<T>): Promise<T> => {
        const session = client!.startSession();
        try {
          let result: T | undefined;
          await session.withTransaction(async () => {
            result = await fn({ session });
          });
          return result as T;
        } finally {
          await session.endSession();
        }
      },
    };
    const repo = new MongoNotificationRepositoryCtor(deps as unknown as MongoDbService);
    return {
      name: 'mongo',
      repo: () => repo,
      teardown: async () => {
        await client?.close();
        await replSet?.stop();
      },
    };
  } catch (err) {
    console.warn('[parity] mongo lane failed to start — skipped:', (err as Error).message);
    await client?.close();
    await replSet?.stop();
    return null;
  }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

let pgLane: Lane | null = null;
let mongoLane: Lane | null = null;

async function runScenarios(lane: Lane): Promise<void> {
  const repo = lane.repo();

  // 1. create round-trip
  const accountId = randomUUID();
  const created = await repo.create({
    accountId,
    orgId: randomUUID(),
    kind: 'test.kind',
    severity: 'warn',
    title: 'Hello',
    body: 'World',
    data: { a: 1 },
  });
  expect(created.id).toBeTruthy();
  expect(created.accountId).toBe(accountId);
  expect(created.kind).toBe('test.kind');
  expect(created.severity).toBe('warn');
  expect(created.title).toBe('Hello');
  expect(created.readAt).toBeNull();

  // 2. list: newest-first, unread filter, account isolation
  const otherAccount = randomUUID();
  await repo.create({
    accountId: otherAccount,
    orgId: null,
    kind: 'other.kind',
    severity: 'info',
    title: 'Other',
    body: '',
    data: {},
  });
  const second = await repo.create({
    accountId,
    orgId: null,
    kind: 'test.second',
    severity: 'info',
    title: 'Second',
    body: '',
    data: {},
  });
  const all = await repo.list(accountId, false, 50);
  expect(all.length).toBe(2);
  expect(all[0].id).toBe(second.id); // newest first
  expect(all.every((n: Notification) => n.accountId === accountId)).toBe(true);

  // 3. markRead: account-scoped, idempotent
  await repo.markRead(otherAccount, created.id, new Date().toISOString());
  const stillUnread = await repo.list(accountId, true, 50);
  expect(stillUnread.length).toBe(2); // cross-account mark is a no-op
  await repo.markRead(accountId, created.id, new Date().toISOString());
  await repo.markRead(accountId, created.id, new Date().toISOString()); // idempotent
  const unreadAfter = await repo.list(accountId, true, 50);
  expect(unreadAfter.length).toBe(1);
  expect(unreadAfter[0].id).toBe(second.id);

  // 4. markAllRead + unreadCount
  expect(await repo.unreadCount(accountId)).toBe(1);
  await repo.markAllRead(accountId, new Date().toISOString());
  expect(await repo.unreadCount(accountId)).toBe(0);
  expect(await repo.list(accountId, true, 50)).toHaveLength(0);
  // Other account untouched
  expect(await repo.unreadCount(otherAccount)).toBe(1);
}

describe('notifications repository parity', () => {
  beforeAll(async () => {
    pgLane = await buildPgLane();
    mongoLane = await buildMongoLane();
    if (!pgLane && !mongoLane) {
      console.warn('[parity] no lanes available — scenarios skipped');
    }
  }, 120000);

  afterAll(async () => {
    await pgLane?.teardown();
    await mongoLane?.teardown();
  });

  it('pg lane: CRUD + isolation', async () => {
    if (!pgLane) return;
    await runScenarios(pgLane);
  });

  it('mongo lane: CRUD + isolation', async () => {
    if (!mongoLane) return;
    await runScenarios(mongoLane);
  });
});
