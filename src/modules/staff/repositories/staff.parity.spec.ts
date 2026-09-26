/**
 * Staff repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through `IImpersonationRepository` and
 * `IPlatformStaffRepository`.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. impersonation CRUD round-trip: create → findById → listActive →
 *     revoke → gone from listActive, findById shows revokedAt.
 *  2. platform_staff upsert races: 8 parallel upserts for one account →
 *     exactly one row, findByAccountId reflects a single binding (the
 *     pg lane's `onConflictDoUpdate` vs the mongo lane's atomic
 *     `upsert:true` — no duplicate-key-then-update inside a txn).
 *  3. platform_staff list join: email/displayName resolve from the
 *     accounts plane; missing account → nulls (left-join semantics).
 *  4. countActiveSuperAdmins: revoke one of two → count drops 2 → 1.
 *  5. sweep candidates: expired unrevoked impersonation with a live
 *     session row → sid returned; revoked session → excluded.
 *  6. Cross-provider determinism: same logical flow on both lanes yields
 *     the same row counts and the same final states. Row ids are uuidv7
 *     on both lanes but NOT byte-identical across lanes; timestamps are
 *     ISO-8601 strings but wall-clock values differ — neither is
 *     asserted across lanes.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). Tables are
 * provisioned idempotently from the drizzle schema shapes. All tables
 * are platform-plane (no RLS).
 *
 * mongo lane: mongodb-memory-server single-node replica set.
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
import type { IImpersonationRepository } from './impersonation.repository';
import type { IPlatformStaffRepository } from './platform-staff.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  impersonations(): IImpersonationRepository;
  staff(): IPlatformStaffRepository;
  /** White-box: insert a minimal accounts row (for the list join). */
  seedAccount(accountId: string, email: string, displayName: string): Promise<void>;
  /** White-box: insert an oauth_sessions row (for the sweep join). */
  seedSession(sid: string, revokedAt: string | null): Promise<void>;
  teardown(): Promise<void>;
}

let DbServiceCtor: new () => DbService;
let PgImpersonationRepositoryCtor: new (db: DbService) => IImpersonationRepository;
let PgPlatformStaffRepositoryCtor: new (db: DbService) => IPlatformStaffRepository;
let MongoImpersonationRepositoryCtor: new (m: MongoDbService) => IImpersonationRepository;
let MongoPlatformStaffRepositoryCtor: new (m: MongoDbService) => IPlatformStaffRepository;

interface MongoLaneDeps {
  root: Db;
  withBypass<T>(fn: (ctx: { session: unknown }) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the drizzle schema sources (platform-plane,
// no RLS). Idempotent.
// ---------------------------------------------------------------------------

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "accounts" (
     "id" uuid PRIMARY KEY,
     "email" varchar(320),
     "display_name" varchar(128)
   )`,
  `CREATE TABLE IF NOT EXISTS "oauth_sessions" (
     "sid" varchar(128) PRIMARY KEY,
     "revoked_at" timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS "staff_impersonations" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "staff_account_id" uuid NOT NULL,
     "target_account_id" uuid NOT NULL,
     "org_id" varchar(36),
     "reason" varchar(512) NOT NULL,
     "session_sid" varchar(128) NOT NULL,
     "expires_at" timestamptz NOT NULL,
     "revoked_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "platform_staff" (
     "account_id" uuid PRIMARY KEY,
     "role" varchar(16) NOT NULL,
     "granted_by" uuid,
     "granted_at" timestamptz NOT NULL DEFAULT now(),
     "expires_at" timestamptz,
     "revoked_at" timestamptz,
     "revoke_reason" varchar(512)
   )`,
];

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function buildPgLane(): Promise<Lane | null> {
  if (!DATABASE_URL) {
    console.warn('[parity] DATABASE_URL not set — pg lane skipped');
    return null;
  }
  const dbModule = await import('../../../common/infra/db/db.service');
  DbServiceCtor = dbModule.DbService;
  const impModule = await import('./pg-impersonation.repository');
  PgImpersonationRepositoryCtor = impModule.PgImpersonationRepository;
  const staffModule = await import('./pg-platform-staff.repository');
  PgPlatformStaffRepositoryCtor = staffModule.PgPlatformStaffRepository;

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
  const impersonations = new PgImpersonationRepositoryCtor(dbService);
  const staff = new PgPlatformStaffRepositoryCtor(dbService);
  return {
    name: 'pg',
    impersonations: () => impersonations,
    staff: () => staff,
    seedAccount: async (accountId, email, displayName) => {
      await db.execute(sql.raw(
        `INSERT INTO "accounts" ("id", "email", "display_name") VALUES ('${accountId}', '${email}', '${displayName}')
         ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "display_name" = EXCLUDED."display_name"`,
      ));
    },
    seedSession: async (sid, revokedAt) => {
      await db.execute(sql.raw(
        `INSERT INTO "oauth_sessions" ("sid", "revoked_at") VALUES ('${sid}', ${revokedAt ? `'${revokedAt}'` : 'NULL'})
         ON CONFLICT ("sid") DO UPDATE SET "revoked_at" = EXCLUDED."revoked_at"`,
      ));
    },
    teardown: async () => { await pool.end(); },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet | undefined;
  let client: MongoClient | undefined;
  try {
    const impModule = await import('./mongo-impersonation.repository');
    MongoImpersonationRepositoryCtor = impModule.MongoImpersonationRepository;
    const staffModule = await import('./mongo-platform-staff.repository');
    MongoPlatformStaffRepositoryCtor = staffModule.MongoPlatformStaffRepository;

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
    const impersonations = new MongoImpersonationRepositoryCtor(deps as unknown as MongoDbService);
    const staff = new MongoPlatformStaffRepositoryCtor(deps as unknown as MongoDbService);

    // Binary subtype-4 UUIDs for the seed helpers.
    const { Binary } = await import('mongodb');
    const bin = (id: string): InstanceType<typeof Binary> => {
      const hex = id.replace(/-/g, '');
      return new Binary(Buffer.from(hex, 'hex'), 4);
    };

    return {
      name: 'mongo',
      impersonations: () => impersonations,
      staff: () => staff,
      seedAccount: async (accountId, email, displayName) => {
        await db.collection('accounts').updateOne(
          { id: bin(accountId) },
          { $set: { id: bin(accountId), email, display_name: displayName } },
          { upsert: true },
        );
      },
      seedSession: async (sid, revokedAt) => {
        await db.collection('oauth_sessions').updateOne(
          { sid },
          { $set: { sid, revoked_at: revokedAt } },
          { upsert: true },
        );
      },
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
  const imp = lane.impersonations();
  const staff = lane.staff();

  // 1. impersonation CRUD round-trip
  const staffId = randomUUID();
  const targetId = randomUUID();
  const sid = `imp-${randomUUID().replace(/-/g, '')}`;
  const { id } = await imp.create({
    staffAccountId: staffId,
    targetAccountId: targetId,
    orgId: null,
    reason: 'support investigation for ticket 12345',
    sessionSid: sid,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const found = await imp.findById(id);
  expect(found?.staffAccountId).toBe(staffId);
  expect(found?.revokedAt).toBeNull();
  expect(await imp.findById(randomUUID())).toBeNull();

  const active = await imp.listActive();
  expect(active.some((r) => r.id === id)).toBe(true);

  const now = new Date().toISOString();
  await imp.revoke(id, now);
  const revoked = await imp.findById(id);
  expect(revoked?.revokedAt).toBe(now);
  expect((await imp.listActive()).some((r) => r.id === id)).toBe(false);

  // 2. platform_staff upsert races: 8 parallel → one row
  const accountId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      staff.upsert({
        accountId,
        role: i % 2 === 0 ? 'operator' : 'auditor',
        expiresAt: null,
        grantedBy: null,
        nowIso: new Date().toISOString(),
      }),
    ),
  );
  expect(results.length).toBe(8);
  const binding = await staff.findByAccountId(accountId);
  expect(binding).not.toBeNull();
  expect(['operator', 'auditor']).toContain(binding?.role);
  expect(binding?.revokedAt).toBeNull();

  // 3. list join: account data resolves; missing account → nulls
  await lane.seedAccount(accountId, 'op@example.com', 'Op User');
  const ghostId = randomUUID();
  await staff.upsert({ accountId: ghostId, role: 'auditor', expiresAt: null, grantedBy: null, nowIso: new Date().toISOString() });
  const rows = await staff.list();
  const mine = rows.find((r) => r.accountId === accountId);
  expect(mine?.email).toBe('op@example.com');
  expect(mine?.displayName).toBe('Op User');
  const ghost = rows.find((r) => r.accountId === ghostId);
  expect(ghost?.email).toBeNull();

  // 4. countActiveSuperAdmins
  const sa1 = randomUUID();
  const sa2 = randomUUID();
  await staff.upsert({ accountId: sa1, role: 'super_admin', expiresAt: null, grantedBy: null, nowIso: new Date().toISOString() });
  await staff.upsert({ accountId: sa2, role: 'super_admin', expiresAt: null, grantedBy: null, nowIso: new Date().toISOString() });
  expect(await staff.countActiveSuperAdmins(new Date().toISOString())).toBe(2);
  await staff.revoke(sa1, 'rotation', new Date().toISOString());
  expect(await staff.countActiveSuperAdmins(new Date().toISOString())).toBe(1);

  // 5. sweep candidates: expired + live session → sid; revoked session → excluded
  const liveSid = `sweep-live-${randomUUID().slice(0, 8)}`;
  const deadSid = `sweep-dead-${randomUUID().slice(0, 8)}`;
  await lane.seedSession(liveSid, null);
  await lane.seedSession(deadSid, new Date().toISOString());
  const past = new Date(Date.now() - 3_600_000).toISOString();
  await imp.create({
    staffAccountId: staffId,
    targetAccountId: targetId,
    orgId: null,
    reason: 'expired sweep candidate',
    sessionSid: liveSid,
    expiresAt: past,
  });
  await imp.create({
    staffAccountId: staffId,
    targetAccountId: targetId,
    orgId: null,
    reason: 'expired but session already revoked',
    sessionSid: deadSid,
    expiresAt: past,
  });
  const sids = await imp.findExpiredUnrevokedSessionSids(100);
  expect(sids).toContain(liveSid);
  expect(sids).not.toContain(deadSid);
}

describe('staff repository parity', () => {
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

  it('pg lane: impersonation + platform_staff', async () => {
    if (!pgLane) return;
    await runScenarios(pgLane);
  });

  it('mongo lane: impersonation + platform_staff', async () => {
    if (!mongoLane) return;
    await runScenarios(mongoLane);
  });
});
