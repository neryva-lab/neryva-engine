/**
 * Audit hash-chain parity spec (P2 proof) — PgAuditStore vs MongoAuditStore.
 *
 * Scenarios (per lane):
 *  1. append 5 entries → verifyChain ok
 *  2. tamper one entry's payload directly → verifyChain fails AT that entry
 *  3. 8 parallel appends → chain stays valid, no forked predecessors
 *  4. CROSS-PROVIDER: the same logical entry sequence through both impls
 *     produces BYTE-IDENTICAL hash strings at every position.
 *
 * pg lane follows the repo's spec DB pattern: gated on DATABASE_URL
 * reachability, raw pg Pool + drizzle (no NestJS, no env.ts import).
 * mongo lane uses mongodb-memory-server (single-node replica set) plus
 * runMongoMigrations; if the memory server cannot start, the mongo scenarios
 * skip with a warning and the pg lane still runs.
 *
 * pg test rows: the per-lane pg scenarios append real rows (audit_events is
 * append-only by design; the existing suites also persist test rows). The
 * cross-provider scenario instead runs the pg sequence inside a ROLLED-BACK
 * transaction that first deletes the table — so it starts from an EMPTY chain
 * (entry 0's prevHash must agree across lanes for byte-identity) and leaves
 * zero trace in the shared table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import {
  PgAuditStore,
  MongoAuditStore,
  AUDIT_EVENTS_COLLECTION,
  canonicalUtcIso,
  type AuditEntry,
  type AuditEntryInput,
} from './audit';
import { uuidToBinary } from '../mongo/mongo-tx';
import type { MongoTxContext } from '../mongo/mongo-tx';
import { runMongoMigrations } from '../mongo/migrations/mongo-migrator';

// ---------------------------------------------------------------------------
// pg lane — repo's spec DB pattern (gate on DATABASE_URL reachability)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function pgReachable(): Promise<boolean> {
  if (!DATABASE_URL) {
    return false;
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

let pgUp = false;

beforeAll(async () => {
  pgUp = await pgReachable();
  if (!pgUp) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
  } else {
    pgLane = makePgLane();
    // The lane scenarios append to the live audit table (each append needs
    // its own transaction for the advisory-lock serialization). Remove rows
    // left by previous parity runs so repeats never contaminate the shared
    // chain — only parity-test rows are touched, real audit rows are never
    // deleted.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await pool.query(`delete from audit_events where action like 'parity-test.%'`);
    } finally {
      await pool.end();
    }
  }
});

interface Lane {
  name: string;
  append(input: AuditEntryInput): Promise<AuditEntry>;
  verify(limit?: number): Promise<{ ok: boolean; brokenAt?: string; checked: number }>;
  tip(): Promise<AuditEntry | null>;
  tamperDetails(id: string, details: Record<string, unknown>): Promise<void>;
  countByEventHash(hash: string): Promise<number>;
}

function makePgLane(): Lane {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  const db = drizzle(pool);
  return {
    name: 'pg',
    append: (input) => db.transaction(async (tx) => new PgAuditStore(tx).append(input)),
    verify: (limit) => new PgAuditStore(db).verifyChain({ limit }),
    tip: () => new PgAuditStore(db).getPredecessor(),
    tamperDetails: async (id, details) => {
      await pool.query('update audit_events set details = $1::jsonb where id = $2', [JSON.stringify(details), id]);
    },
    countByEventHash: async (hash) => {
      const r = await pool.query('select count(*)::int as n from audit_events where event_hash = $1', [hash]);
      return r.rows[0].n as number;
    },
  };
}

// ---------------------------------------------------------------------------
// mongo lane — mongodb-memory-server single-node replica set
// ---------------------------------------------------------------------------

let mongoReplset: MongoMemoryReplSet | undefined;
let mongoClient: MongoClient | undefined;
let mongoDb: Db | undefined;
let mongoReady = false;

beforeAll(async () => {
  try {
    mongoReplset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    mongoClient = new MongoClient(mongoReplset.getUri());
    await mongoClient.connect();
    mongoDb = mongoClient.db('neryva_audit_parity');
    await runMongoMigrations(mongoDb);
    await MongoAuditStore.ensureIndexes(mongoDb);
    mongoReady = true;
  } catch (err) {
    console.warn('[parity] mongodb-memory-server failed to start — mongo lane skipped:', (err as Error).message);
  }
}, 300_000);

afterAll(async () => {
  await mongoClient?.close().catch(() => undefined);
  await mongoReplset?.stop().catch(() => undefined);
});

interface MongoLane extends Lane {
  /** Append on a fresh session — parallel appends must not share a session. */
  appendFresh(input: AuditEntryInput): Promise<AuditEntry>;
}

function makeMongoLane(): MongoLane | null {
  if (!mongoReady || !mongoClient || !mongoDb) {
    return null;
  }
  const client = mongoClient;
  const db = mongoDb;
  const serialSession = client.startSession();
  const serialCtx: MongoTxContext = { session: serialSession, orgId: null };
  return {
    name: 'mongo',
    append: (input) => new MongoAuditStore(db, serialCtx).append(input),
    appendFresh: async (input) => {
      const s = client.startSession();
      try {
        return await new MongoAuditStore(db, { session: s, orgId: null }).append(input);
      } finally {
        await s.endSession();
      }
    },
    verify: (limit) => new MongoAuditStore(db, serialCtx).verifyChain({ limit }),
    tip: () => new MongoAuditStore(db, serialCtx).getPredecessor(),
    tamperDetails: async (id, details) => {
      await db
        .collection(AUDIT_EVENTS_COLLECTION)
        .updateOne({ id: uuidToBinary(id) }, { $set: { details } });
    },
    countByEventHash: (hash) => db.collection(AUDIT_EVENTS_COLLECTION).countDocuments({ event_hash: hash }),
  };
}

// ---------------------------------------------------------------------------
// shared scenarios
// ---------------------------------------------------------------------------

function plusMicros(iso: string, deltaMicros: number): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})(\+00:00)$/);
  if (!m) {
    throw new Error(`not a canonical µs iso: ${iso}`);
  }
  const micros = Number.parseInt(m[2], 10) + deltaMicros;
  if (micros >= 1_000_000) {
    throw new Error('plusMicros overflow');
  }
  return `${m[1]}.${micros.toString().padStart(6, '0')}${m[3]}`;
}

function laneScenarios(name: string, getLane: () => Lane | null): void {
  describe(`audit chain parity — ${name} lane`, () => {
    const tenantId = randomUUID();

    function need(): Lane | null {
      const lane = getLane();
      if (!lane) {
        console.warn(`[parity] ${name} lane unavailable — scenario skipped`);
      }
      return lane;
    }

    function entryInput(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
      return {
        action: 'parity-test.append',
        resourceType: 'parity_probe',
        actorType: 'service',
        actorId: `svc-${randomUUID().slice(0, 8)}`,
        resourceId: `res-${randomUUID().slice(0, 8)}`,
        tenantId,
        details: { seq: 1, nested: { a: [1, 2, 3], b: 'x' }, flag: true, nil: null, uni: 'héllo→世界' },
        ...overrides,
      };
    }

    it('append 5 entries → verifyChain ok', async () => {
      const lane = need();
      if (!lane) return;
      for (let i = 0; i < 5; i += 1) {
        await lane.append(entryInput({ action: `parity-test.append-${i}`, details: { i } }));
      }
      const res = await lane.verify(100_000);
      expect(res.ok).toBe(true);
      expect(res.checked).toBeGreaterThanOrEqual(5);
    });

    it("tamper one entry's payload directly → verifyChain fails at that entry", async () => {
      const lane = need();
      if (!lane) return;
      const appended = await lane.append(
        entryInput({ action: 'parity-test.tamper-target', details: { original: true } }),
      );
      await lane.tamperDetails(appended.id, { original: false, tampered: true });
      const broken = await lane.verify(100_000);
      expect(broken.ok).toBe(false);
      expect(broken.brokenAt).toBe(appended.id);
      // restore — the chain is append-only; the test must leave it verifiable
      await lane.tamperDetails(appended.id, { original: true });
      const healed = await lane.verify(100_000);
      expect(healed.ok).toBe(true);
    });

    it('8 parallel appends → single chain, no forked predecessors', async () => {
      const lane = need();
      if (!lane) return;
      const tipBefore = await lane.tip();
      expect(tipBefore).not.toBeNull();
      const appendFn =
        (lane as Partial<MongoLane>).appendFresh?.bind(lane) ?? lane.append.bind(lane);
      const entries = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          appendFn(entryInput({ action: `parity-test.concurrent-${i}`, details: { slot: i } })),
        ),
      );
      const verified = await lane.verify(100_000);
      expect(verified.ok).toBe(true);
      // canonical order == pg's (created_at, id) == mongo's (created_at_iso, id)
      const ordered = [...entries].sort((a, b) =>
        a.createdAtIso < b.createdAtIso ? -1 : a.createdAtIso > b.createdAtIso ? 1 : a.id < b.id ? -1 : 1,
      );
      expect(ordered[0]?.prevHash).toBe(tipBefore?.hash ?? null);
      for (let i = 1; i < ordered.length; i += 1) {
        expect(ordered[i]?.prevHash).toBe(ordered[i - 1]?.hash);
      }
      // no fork: every prevHash is distinct and resolves to exactly one row
      const prevHashes = entries.map((e) => e.prevHash);
      expect(new Set(prevHashes).size).toBe(entries.length);
      for (const h of prevHashes) {
        expect(await lane.countByEventHash(h as string)).toBe(1);
      }
    });
  });
}

let pgLane: Lane | null = null;
laneScenarios('pg', () => pgLane);
laneScenarios('mongo', () => makeMongoLane());

// ---------------------------------------------------------------------------
// cross-provider hash identity
// ---------------------------------------------------------------------------

describe('audit chain parity — cross-provider hash identity', () => {
  it('identical logical entries → byte-identical hashes on both lanes', async () => {
    if (!pgUp || !pgLane) {
      console.warn('[parity] pg lane unavailable — cross-provider test skipped');
      return;
    }
    const mongoLane = makeMongoLane();
    if (!mongoLane || !mongoDb || !mongoClient) {
      console.warn('[parity] mongo lane unavailable — cross-provider test skipped');
      return;
    }

    const tenantId = randomUUID();
    const base = canonicalUtcIso(new Date());
    const inputs: AuditEntryInput[] = [0, 1, 2, 3, 4].map((i) => ({
      id: randomUUID(),
      createdAtIso: plusMicros(base, i * 7),
      action: `parity-test.xprov-${i}`,
      resourceType: 'parity_probe',
      actorType: i % 2 === 0 ? 'service' : 'account',
      actorId: i === 4 ? null : `actor-${i}`,
      resourceId: `res-${i}`,
      tenantId: i === 3 ? null : tenantId,
      productTag: i === 1 ? 'neryva' : null,
      details: { i, nested: { k: `v-${i}`, arr: [i, i + 1] }, flag: i % 2 === 0, note: 'café → 測試' },
    }));

    // pg: the whole sequence runs inside ONE rolled-back transaction that
    // first empties the table — the chain starts empty (entry 0's prevHash is
    // null on both lanes) and the shared table is left untouched.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const db = drizzle(pool);
    const pgHashes: string[] = [];
    const ROLLBACK = Symbol('parity-rollback');
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`delete from audit_events`);
        const store = new PgAuditStore(tx);
        for (const input of inputs) {
          pgHashes.push((await store.append(input)).hash);
        }
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) {
        throw err;
      }
    } finally {
      await pool.end();
    }
    expect(pgHashes).toHaveLength(5);

    // mongo: the memory-server DB starts empty; deleteMany makes it explicit.
    await mongoDb.collection(AUDIT_EVENTS_COLLECTION).deleteMany({});
    const mongoHashes: string[] = [];
    const s = mongoClient.startSession();
    try {
      const store = new MongoAuditStore(mongoDb, { session: s, orgId: null });
      for (const input of inputs) {
        mongoHashes.push((await store.append(input)).hash);
      }
      const tip = await store.getPredecessor();
      expect(tip?.hash).toBe(mongoHashes[4]);
      const verified = await store.verifyChain({ limit: 100 });
      expect(verified.ok).toBe(true);
      expect(verified.checked).toBe(5);
    } finally {
      await s.endSession();
    }

    // THE assertion: byte-identical hashes at every position.
    expect(mongoHashes).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) {
      expect(mongoHashes[i]).toBe(pgHashes[i]);
    }
  }, 120_000);
});
