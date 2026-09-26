import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  IIdempotencyStore,
  IdempotencyKey,
  IdempotencyResponse,
  MongoIdempotencyStore,
  PgIdempotencyStore,
} from './idempotency';
import { ApiError } from '../../../http/api-error';
import { uuidToBinary } from '../mongo/mongo-tx';
import { runMongoMigrations } from '../mongo/migrations/mongo-migrator';

/**
 * Behavioral parity spec for the durable-idempotency port (plan P2/D10).
 *
 * Every scenario runs against BOTH lanes through the same `LaneHarness`
 * interface and asserts identical outcomes:
 * - pg: real PostgreSQL (gated on TEST_DATABASE_URL, repo integration-test
 *   pattern — skipped when unreachable), `idempotency_records` ensured via
 *   idempotent DDL copied from `drizzle/0023_async_foundation.sql`, RLS
 *   context applied exactly like `DbService.withOrg`.
 * - mongo: `mongodb-memory-server` single-node replica set
 *   (`replSet: {count:1, storageEngine:'wiredTiger'}`), `runMongoMigrations`
 *   applied, then the store's defensive `ensureIndexes` (idempotent).
 *
 * Not run during iteration (user directive) — single final run only.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function keyFor(orgId: string, overrides: Partial<IdempotencyKey> = {}): IdempotencyKey {
  return {
    organizationId: orgId,
    principalId: 'principal-1',
    endpointFamily: 'messages.start',
    idempotencyKey: randomUUID(),
    requestHash: 'hash-abc-123',
    ...overrides,
  };
}

const RESP: IdempotencyResponse = { statusCode: 200, bodyHash: 'bodyhash-1', body: { ok: true } };

function expectConflict409(err: unknown, code: 'idempotency_conflict' | 'idempotency_in_flight'): void {
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
  expect((err as ApiError).getStatus()).toBe(409);
}

/** Provider-neutral lane: one transactional store invocation per call. */
interface LaneHarness {
  label: string;
  tx<T>(orgId: string, fn: (store: IIdempotencyStore) => Promise<T>): Promise<T>;
  /** White-box status/expiry manipulation for the FAILED_* and expiry branches. */
  setRow: (orgId: string, key: IdempotencyKey, patch: { status?: string; expiresAt?: string }) => Promise<void>;
  teardown: () => Promise<void>;
}

interface TestSkip {
  skip: (note?: string) => never;
}

function scenarioSuite(label: string, getHarness: () => LaneHarness | null, loudMissing: boolean): void {
  describe(`${label}: durable idempotency parity`, () => {
    const H = (t: TestSkip): LaneHarness => {
      const h = getHarness();
      if (!h) {
        // pg lane without a reachable DB skips (repo integration-test
        // pattern); the mongo lane fails loudly instead — see the
        // "memory server started" test.
        if (loudMissing) throw new Error(`${label} harness unavailable — see setup failure above`);
        t.skip('pg lane skipped: TEST_DATABASE_URL unreachable');
      }
      return h;
    };
    it('claim → complete → get replays the stored response', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      const claim = await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      expect(claim).toBe('claimed');
      await harness.tx(orgId, (s) => s.complete(key, RESP));
      const rec = await harness.tx(orgId, (s) => s.get(key));
      expect(rec).not.toBeNull();
      expect(rec?.status).toBe('SUCCEEDED');
      expect(rec?.response).toEqual(RESP);
      expect(rec?.organizationId).toBe(orgId);
      expect(rec?.principalId).toBe(key.principalId);
      expect(rec?.endpointFamily).toBe(key.endpointFamily);
      expect(rec?.idempotencyKey).toBe(key.idempotencyKey);
    });

    it("duplicate claim on a completed key returns 'duplicate' and preserves the original response", async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      await harness.tx(orgId, (s) => s.complete(key, RESP));
      const dup = await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      expect(dup).toBe('duplicate');
      const rec = await harness.tx(orgId, (s) => s.get(key));
      expect(rec?.response).toEqual(RESP);
    });

    it('same key + different requestHash → 409 idempotency_conflict', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      const err = await harness
        .tx(orgId, (s) => s.tryClaim(keyFor(orgId, { idempotencyKey: key.idempotencyKey, requestHash: 'hash-DIFFERENT' }), 60_000))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expectConflict409(err, 'idempotency_conflict');
    });

    it('duplicate claim while in flight → 409 idempotency_in_flight', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      const err = await harness.tx(orgId, (s) => s.tryClaim(key, 60_000)).then(
        () => null,
        (e: unknown) => e,
      );
      expectConflict409(err, 'idempotency_in_flight');
    });

    it('8 parallel claims → exactly one claimed', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => harness.tx(orgId, (s) => s.tryClaim(key, 60_000))),
      );
      const claimed = results.filter((r) => r.status === 'fulfilled' && r.value === 'claimed');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(claimed).toHaveLength(1);
      expect(rejected).toHaveLength(7);
      for (const r of rejected) {
        expectConflict409((r as PromiseRejectedResult).reason, 'idempotency_in_flight');
      }
    });

    it('different keys / endpoint families / principals / orgs do not collide', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const base = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(base, 60_000));
      expect(await harness.tx(orgId, (s) => s.tryClaim(keyFor(orgId, { idempotencyKey: randomUUID() }), 60_000))).toBe('claimed');
      expect(await harness.tx(orgId, (s) => s.tryClaim(keyFor(orgId, { endpointFamily: 'runs.cancel' }), 60_000))).toBe('claimed');
      expect(await harness.tx(orgId, (s) => s.tryClaim(keyFor(orgId, { principalId: 'principal-2' }), 60_000))).toBe('claimed');
      // Same idempotency_key value in a different org must not collide — one
      // orgId for both the tenant context and the key (a mismatch is correctly
      // rejected by RLS, which is what the cross-org isolation test proves).
      const otherOrg = randomUUID();
      expect(await harness.tx(otherOrg, (s) => s.tryClaim(keyFor(otherOrg, { idempotencyKey: base.idempotencyKey }), 60_000))).toBe('claimed');
    });

    it('expired IN_PROGRESS claim can be re-claimed', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      expect(await harness.tx(orgId, (s) => s.tryClaim(key, 10))).toBe('claimed');
      await sleep(150);
      expect(await harness.tx(orgId, (s) => s.tryClaim(key, 60_000))).toBe('claimed');
    });

    it('FAILED_RETRYABLE row can be re-claimed', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      await harness.setRow(orgId, key, { status: 'FAILED_RETRYABLE' });
      expect(await harness.tx(orgId, (s) => s.tryClaim(key, 60_000))).toBe('claimed');
    });

    it('FAILED_FINAL row → 409 idempotency_conflict', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      await harness.setRow(orgId, key, { status: 'FAILED_FINAL' });
      const err = await harness.tx(orgId, (s) => s.tryClaim(key, 60_000)).then(
        () => null,
        (e: unknown) => e,
      );
      expectConflict409(err, 'idempotency_conflict');
    });

    it('expired SUCCEEDED row still replays — never re-claimed by a retry', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const key = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(key, 60_000));
      await harness.tx(orgId, (s) => s.complete(key, RESP));
      await harness.setRow(orgId, key, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
      expect(await harness.tx(orgId, (s) => s.tryClaim(key, 60_000))).toBe('duplicate');
      const rec = await harness.tx(orgId, (s) => s.get(key));
      expect(rec?.response).toEqual(RESP);
    });

    it('releaseExpired purges only expired rows', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      const expiredKey = keyFor(orgId);
      const freshKey = keyFor(orgId);
      await harness.tx(orgId, (s) => s.tryClaim(expiredKey, 10));
      await harness.tx(orgId, (s) => s.tryClaim(freshKey, 3_600_000));
      await sleep(150);
      expect(await harness.tx(orgId, (s) => s.releaseExpired(0))).toBe(1);
      expect(await harness.tx(orgId, (s) => s.get(expiredKey))).toBeNull();
      expect(await harness.tx(orgId, (s) => s.get(freshKey))).not.toBeNull();
      expect(await harness.tx(orgId, (s) => s.releaseExpired(3_600_000))).toBe(0);
    });

    it('get on an unknown key → null', async (t) => {
      const harness = H(t);
      const orgId = randomUUID();
      expect(await harness.tx(orgId, (s) => s.get(keyFor(orgId)))).toBeNull();
    });

    it('cross-org reads are isolated', async (t) => {
      const harness = H(t);
      const orgA = randomUUID();
      const orgB = randomUUID();
      const key = keyFor(orgA);
      await harness.tx(orgA, (s) => s.tryClaim(key, 60_000));
      await harness.tx(orgA, (s) => s.complete(key, RESP));
      expect(await harness.tx(orgB, (s) => s.get(key))).toBeNull();
    });
  });
}

// ── pg lane ────────────────────────────────────────────────────────────────

async function pgReachable(): Promise<boolean> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return false;
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

/** Idempotent DDL — table shape from drizzle/0023_async_foundation.sql §idempotency_records,
 *  RLS policy in the CURRENT hardened shape from drizzle/0060_rls_empty_tenant_guard.sql
 *  (nullif(..., '') guard — 0023's bare ::uuid cast throws 22P02 on the '' placeholder
 *  that withBypass legitimately sets, aborting before the bypass branch admits). */
async function ensurePgTable(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "idempotency_records" (
      "organization_id" uuid NOT NULL,
      "principal_id" varchar(128) NOT NULL,
      "endpoint_family" varchar(64) NOT NULL,
      "idempotency_key" varchar(255) NOT NULL,
      "request_hash" varchar(64) NOT NULL,
      "status" varchar(32) NOT NULL DEFAULT 'IN_PROGRESS',
      "resource_ref" jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "expires_at" timestamptz NOT NULL,
      PRIMARY KEY ("organization_id", "principal_id", "endpoint_family", "idempotency_key"),
      CONSTRAINT "chk_idem_status" CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL'))
    )`);
  await db.execute(sql`ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY`);
  await db.execute(sql`ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY`);
  await db.execute(sql`DROP POLICY IF EXISTS "idempotency_records_tenant_isolation" ON "idempotency_records"`);
  await db.execute(sql`
    CREATE POLICY "idempotency_records_tenant_isolation" ON "idempotency_records"
      USING (organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)
      WITH CHECK (organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ix_idempotency_expiry" ON "idempotency_records" ("expires_at")`);
}

async function makePgHarness(): Promise<LaneHarness> {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
  const db = drizzle(pool);
  await ensurePgTable(db);
  const orgIds = new Set<string>();

  const tx = async <T>(orgId: string, fn: (store: IIdempotencyStore) => Promise<T>): Promise<T> => {
    orgIds.add(orgId);
    return db.transaction(async (t) => {
      // Same RLS context discipline as DbService.withOrg.
      await t.execute(sql`select set_config('app.current_tenant', ${orgId}, true)`);
      await t.execute(sql`select set_config('app.engine_bypass', 'off', true)`);
      return fn(new PgIdempotencyStore(t));
    });
  };

  return {
    label: 'pg',
    tx,
    setRow: async (orgId, key, patch) =>
      // White-box: bypass RLS for the status/expiry flip, exactly like the
      // worker sweep paths do.
      db.transaction(async (t) => {
        await t.execute(sql`select set_config('app.engine_bypass', 'on', true)`);
        await t.execute(sql`select set_config('app.current_tenant', '', true)`);
        if (patch.status !== undefined) {
          await t.execute(sql`
            update idempotency_records set status = ${patch.status}
            where organization_id = ${orgId}::uuid
              and principal_id = ${key.principalId}
              and endpoint_family = ${key.endpointFamily}
              and idempotency_key = ${key.idempotencyKey}`);
        }
        if (patch.expiresAt !== undefined) {
          await t.execute(sql`
            update idempotency_records set expires_at = ${patch.expiresAt}::timestamptz
            where organization_id = ${orgId}::uuid
              and principal_id = ${key.principalId}
              and endpoint_family = ${key.endpointFamily}
              and idempotency_key = ${key.idempotencyKey}`);
        }
      }),
    teardown: async () => {
      // Best-effort cleanup of this spec's rows only (tracked orgIds).
      await db
        .transaction(async (t) => {
          await t.execute(sql`select set_config('app.engine_bypass', 'on', true)`);
          await t.execute(sql`select set_config('app.current_tenant', '', true)`);
          for (const id of orgIds) {
            await t.execute(sql`delete from idempotency_records where organization_id = ${id}::uuid`);
          }
        })
        .catch(() => undefined);
      await pool.end();
    },
  };
}

// ── mongo lane ─────────────────────────────────────────────────────────────

async function makeMongoHarness(): Promise<LaneHarness> {
  const replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const client = new MongoClient(replset.getUri());
  await client.connect();
  const db: Db = client.db('idem_parity');
  await runMongoMigrations(db);
  // Prove the 0001 migration provisioned the unique scope index, then run
  // the store's defensive ensureIndexes (idempotent).
  const indexes = await db.collection('idempotency_records').listIndexes().toArray();
  expect(indexes.some((ix) => ix.name === 'pk_idempotency_records' && ix.unique === true)).toBe(true);
  await MongoIdempotencyStore.ensureIndexes(db);

  return {
    label: 'mongo',
    tx: async <T>(orgId: string, fn: (store: IIdempotencyStore) => Promise<T>): Promise<T> => {
      const session = client.startSession();
      try {
        return await fn(new MongoIdempotencyStore(db, { session, orgId }));
      } finally {
        await session.endSession();
      }
    },
    setRow: async (orgId, key, patch) => {
      const update: Record<string, unknown> = {};
      if (patch.status !== undefined) update.status = patch.status;
      if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt;
      await db.collection('idempotency_records').updateOne(
        {
          organization_id: uuidToBinary(orgId),
          principal_id: key.principalId,
          endpoint_family: key.endpointFamily,
          idempotency_key: key.idempotencyKey,
        },
        { $set: update },
      );
    },
    teardown: async () => {
      // Memory server is ephemeral; drop the collection for tidiness.
      await db.collection('idempotency_records').drop().catch(() => undefined);
      await client.close();
      await replset.stop();
    },
  };
}

// ── suite wiring ───────────────────────────────────────────────────────────

describe('idempotency port — pg lane (requires TEST_DATABASE_URL)', () => {
  let harness: LaneHarness | null = null;
  beforeAll(async () => {
    if (!(await pgReachable())) return; // scenarios skip at runtime
    harness = await makePgHarness();
  }, 60_000);
  afterAll(async () => {
    await harness?.teardown();
  });
  scenarioSuite('pg', () => harness, false);
});

describe('idempotency port — mongo lane (mongodb-memory-server replset)', () => {
  let harness: LaneHarness | null = null;
  let startError: unknown = null;
  beforeAll(async () => {
    try {
      harness = await makeMongoHarness();
    } catch (err) {
      startError = err;
    }
  }, 240_000);
  afterAll(async () => {
    await harness?.teardown();
  });
  it('memory server started', () => {
    // Loud failure, never a silent skip: if the memory server cannot start
    // in this environment the spec must say so.
    expect(startError, startError instanceof Error ? startError.message : String(startError)).toBeNull();
    expect(harness).not.toBeNull();
  });
  scenarioSuite('mongo', () => harness, true);
});
