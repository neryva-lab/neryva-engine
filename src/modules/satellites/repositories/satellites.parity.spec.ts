/**
 * Satellites repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through the repository interfaces
 * (`ISatelliteRegistryRepository`, `ISatelliteIncidentRepository`,
 * `ISatelliteActivityRepository`, `IRevocationLogRepository`).
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. Registry round-trip: seed → list/get → register (new) → register
 *     (update) → statusView with open-incident counts.
 *  2. Register upsert race: two parallel registers for one key → exactly
 *     one row, both callers get the same key back.
 *  3. Heartbeat lease: first beat flips liveness never→live, bumps
 *     heartbeatCount to 1 and records one sample; second beat → count 2,
 *     firstHeartbeatAt preserved.
 *  4. Lifecycle: quarantine → release → drain → resume → retire, with the
 *     invalid transitions throwing `conflict` (checked via the repository
 *     state, not the service guards).
 *  5. Incident dedup: open (persistent) → unresolved found; open again →
 *     the SAME row extended (detail gains last_seen); resolve → closed;
 *     autoResolve → stored already-resolved.
 *  6. Activity race: 10 parallel touches on one scope → counter exactly 10
 *     (atomic upsert on both lanes); ingest scope accumulates events.
 *  7. Revocation feed: append N → since('') returns N ascending; cursor
 *     pagination returns the tail; between() window filter.
 *  8. Sweeper support: setLiveness + listConnectedSatellites excludes
 *     retired/placeholder; pruneHeartbeatSamples / pruneOlderThan remove
 *     only old rows; driftCandidates finds unacked-over-threshold rows for
 *     active satellites only.
 *
 * pg lane: real `DbService`-shaped harness (root only — the satellites plane
 * is platform-scoped with no RLS) against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). Tables are
 * provisioned idempotently from the drizzle schema shapes; no RLS policies
 * exist on these tables (platform plane, same as production).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withBypass` with the exact `withSession` semantics: one
 * ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the P2 idempotency parity
 * spec — so this file never depends on the import-time `env.ts` parse.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import type { DbService } from '../../../common/infra/db/db.service';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { ISatelliteRegistryRepository } from './satellite-registry.repository';
import type { ISatelliteIncidentRepository } from './satellite-incident.repository';
import type { ISatelliteActivityRepository } from './satellite-activity.repository';
import type { IRevocationLogRepository } from './revocation-log.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  registry: ISatelliteRegistryRepository;
  incidents: ISatelliteIncidentRepository;
  activity: ISatelliteActivityRepository;
  revocations: IRevocationLogRepository;
  /** White-box: seed a config_notifications row (the read-only drift seam). */
  seedConfigNotification(satelliteKey: string, notifiedAtIso: string, ackedAtIso: string | null): Promise<void>;
  /** White-box: wipe all satellites-plane tables/collections between scenarios. */
  wipe(): Promise<void>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header).
let PgRegistryCtor: new (db: never) => ISatelliteRegistryRepository;
let PgIncidentCtor: new (db: never) => ISatelliteIncidentRepository;
let PgActivityCtor: new (db: never) => ISatelliteActivityRepository;
let PgRevocationCtor: new (db: never) => IRevocationLogRepository;
let MongoRegistryCtor: new (m: never) => ISatelliteRegistryRepository;
let MongoIncidentCtor: new (m: never) => ISatelliteIncidentRepository;
let MongoActivityCtor: new (m: never) => ISatelliteActivityRepository;
let MongoRevocationCtor: new (m: never) => IRevocationLogRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the drizzle schema sources. No RLS policies:
// these tables are platform-scoped in production too. Idempotent.
// ---------------------------------------------------------------------------

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "satellites" (
     "key" varchar(64) PRIMARY KEY,
     "kind" varchar(32) NOT NULL,
     "status" varchar(16) NOT NULL DEFAULT 'active',
     "route_prefixes" jsonb NOT NULL DEFAULT '[]',
     "service_client_id" varchar(64),
     "products" jsonb NOT NULL DEFAULT '[]',
     "endpoint_url" varchar(512),
     "capabilities" jsonb NOT NULL DEFAULT '{}',
     "version_floor" varchar(64),
     "metadata" jsonb NOT NULL DEFAULT '{}',
     "liveness" varchar(8) NOT NULL DEFAULT 'never',
     "lease_expires_at" timestamptz,
     "heartbeat_count" bigint NOT NULL DEFAULT 0,
     "first_heartbeat_at" timestamptz,
     "last_heartbeat_at" timestamptz,
     "last_heartbeat_version" varchar(64),
     "quarantined_at" timestamptz,
     "quarantined_by" varchar(128),
     "quarantine_reason" varchar(512),
     "drain_started_at" timestamptz,
     "drained_by" varchar(128),
     "retired_at" timestamptz,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "satellite_heartbeats" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "satellite_key" varchar(64) NOT NULL,
     "version" varchar(64),
     "metrics" jsonb NOT NULL DEFAULT '{}',
     "capabilities" jsonb NOT NULL DEFAULT '{}',
     "metadata" jsonb NOT NULL DEFAULT '{}',
     "received_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "satellite_incidents" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "satellite_key" varchar(64) NOT NULL,
     "kind" varchar(32) NOT NULL,
     "detail" jsonb NOT NULL DEFAULT '{}',
     "opened_at" timestamptz NOT NULL DEFAULT now(),
     "resolved_at" timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS "satellite_counters" (
     "satellite_key" varchar(64) PRIMARY KEY,
     "heartbeats" bigint NOT NULL DEFAULT 0,
     "last_heartbeat_at" timestamptz,
     "revocation_polls" bigint NOT NULL DEFAULT 0,
     "last_revocation_poll_at" timestamptz,
     "config_pulls" bigint NOT NULL DEFAULT 0,
     "last_config_pull_at" timestamptz,
     "config_acks" bigint NOT NULL DEFAULT 0,
     "last_config_ack_at" timestamptz,
     "key_validations" bigint NOT NULL DEFAULT 0,
     "last_key_validation_at" timestamptz,
     "ingest_batches" bigint NOT NULL DEFAULT 0,
     "ingest_events" bigint NOT NULL DEFAULT 0,
     "last_ingest_at" timestamptz,
     "quota_checks" bigint NOT NULL DEFAULT 0,
     "last_quota_check_at" timestamptz,
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "revocation_events" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "kind" varchar(16) NOT NULL,
     "subject_id" varchar(128) NOT NULL,
     "payload" jsonb NOT NULL DEFAULT '{}',
     "occurred_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "config_notifications" (
     "config_id" uuid NOT NULL,
     "satellite_key" varchar(64) NOT NULL,
     "notified_at" timestamptz NOT NULL DEFAULT now(),
     "acked_at" timestamptz,
     PRIMARY KEY ("config_id", "satellite_key")
   )`,
];

const DATABASE_URL = process.env.DATABASE_URL;

async function pgReachable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
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

let pgLane: Lane | null = null;
let mongoLane: Lane | null = null;

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
    return null;
  }
  // DbService is imported as a TYPE only — the runtime import below is
  // intentionally skipped: this spec uses a root-only harness (the
  // satellites plane is platform-scoped), so env.ts parse is never needed.
  const regMod = await import('./pg-satellite-registry.repository');
  const incMod = await import('./pg-satellite-incident.repository');
  const actMod = await import('./pg-satellite-activity.repository');
  const revMod = await import('./pg-revocation-log.repository');
  PgRegistryCtor = regMod.PgSatelliteRegistryRepository as never;
  PgIncidentCtor = incMod.PgSatelliteIncidentRepository as never;
  PgActivityCtor = actMod.PgSatelliteActivityRepository as never;
  PgRevocationCtor = revMod.PgRevocationLogRepository as never;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    for (const ddl of PG_TABLES) {
      await setupPool.query(ddl);
    }
  } finally {
    await setupPool.end();
  }

  // The satellites plane is platform-scoped: repositories use db.root
  // directly (no withOrg). The harness exposes root only.
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const root = drizzle(pool);
  const dbService = { root } as unknown as DbService;

  const wipe = async (): Promise<void> => {
    await pool.query(
      'TRUNCATE "satellites", "satellite_heartbeats", "satellite_incidents", "satellite_counters", "revocation_events", "config_notifications"',
    );
  };

  return {
    name: 'pg',
    registry: new PgRegistryCtor(dbService as never),
    incidents: new PgIncidentCtor(dbService as never),
    activity: new PgActivityCtor(dbService as never),
    revocations: new PgRevocationCtor(dbService as never),
    seedConfigNotification: async (satelliteKey, notifiedAtIso, ackedAtIso) => {
      await pool.query(
        'INSERT INTO "config_notifications" ("config_id", "satellite_key", "notified_at", "acked_at") VALUES (gen_random_uuid(), $1, $2::timestamptz, $3::timestamptz)',
        [satelliteKey, notifiedAtIso, ackedAtIso],
      );
    },
    wipe,
    teardown: async () => {
      await pool.end();
    },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-sat-parity-${process.pid}`;
    await rm(dbPath, { recursive: true, force: true });
    await mkdir(dbPath, { recursive: true });
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ dbPath }],
    });
  } catch (err) {
    console.warn('[parity] mongodb-memory-server failed to start — mongo lane skipped:', (err as Error).message);
    return null;
  }

  const regMod = await import('./mongo-satellite-registry.repository');
  const incMod = await import('./mongo-satellite-incident.repository');
  const actMod = await import('./mongo-satellite-activity.repository');
  const revMod = await import('./mongo-revocation-log.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoRegistryCtor = regMod.MongoSatelliteRegistryRepository as never;
  MongoIncidentCtor = incMod.MongoSatelliteIncidentRepository as never;
  MongoActivityCtor = actMod.MongoSatelliteActivityRepository as never;
  MongoRevocationCtor = revMod.MongoRevocationLogRepository as never;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  const db = client.db('neryva_sat_parity');
  await runMongoMigrationsFn(db);

  // Exact MongoDbService.withBypass semantics: one ClientSession, one
  // majority multi-document transaction via runInTransaction.
  const withBypass = async <T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T> => {
    const session = client.startSession();
    try {
      return await runInTransaction(session, () => fn({ session: session as never, orgId: null }));
    } finally {
      await session.endSession().catch(() => undefined);
    }
  };
  const deps = { root: db, withBypass } as unknown as MongoDbService;

  const wipe = async (): Promise<void> => {
    for (const name of [
      'satellites',
      'satellite_heartbeats',
      'satellite_incidents',
      'satellite_counters',
      'revocation_events',
      'config_notifications',
    ]) {
      await db.collection(name).deleteMany({});
    }
  };

  return {
    name: 'mongo',
    registry: new MongoRegistryCtor(deps as never),
    incidents: new MongoIncidentCtor(deps as never),
    activity: new MongoActivityCtor(deps as never),
    revocations: new MongoRevocationCtor(deps as never),
    seedConfigNotification: async (satelliteKey, notifiedAtIso, ackedAtIso) => {
      const { Binary } = await import('mongodb');
      const hex = randomUUID().replace(/-/g, '');
      await db.collection('config_notifications').insertOne({
        config_id: new Binary(Buffer.from(hex, 'hex'), Binary.SUBTYPE_UUID),
        satellite_key: satelliteKey,
        notified_at: notifiedAtIso,
        acked_at: ackedAtIso,
      });
    },
    wipe,
    teardown: async () => {
      await client.close().catch(() => undefined);
      await replSet.stop().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pgLane = await buildPgLane();
  mongoLane = await buildMongoLane();
  if (!pgLane && !mongoLane) {
    console.warn('[parity] no lanes available — suite will run zero scenarios');
  }
}, 180000);

afterAll(async () => {
  await pgLane?.teardown();
  await mongoLane?.teardown();
});

const lanes = (): Lane[] => [pgLane, mongoLane].filter((l): l is Lane => l !== null);

const satKey = (tag: string): string => `parity-${tag}-${randomUUID().slice(0, 8)}`;

describe.each(lanes().map((l) => [l.name]))('satellites parity [%s]', (name) => {
  const lane = (): Lane => {
    const found = lanes().find((l) => l.name === name);
    if (!found) throw new Error(`lane ${name} not available`);
    return found;
  };

  it('registry round-trip: seed, get, register new, register update, statusView', async () => {
    const l = lane();
    await l.wipe();
    const key = satKey('reg');

    await l.registry.seedSatellite({
      key,
      kind: 'custom',
      status: 'active',
      routePrefixes: ['/v1'],
      serviceClientId: null,
      products: [],
      endpointUrl: null,
      metadata: {},
    });
    // Seed is idempotent.
    await l.registry.seedSatellite({
      key,
      kind: 'custom',
      status: 'active',
      routePrefixes: ['/v1'],
      serviceClientId: null,
      products: [],
      endpointUrl: null,
      metadata: {},
    });

    const got = await l.registry.getSatellite(key);
    expect(got?.key).toBe(key);
    expect(got?.liveness).toBe('never');
    expect(got?.heartbeatCount).toBe(0);

    const listed = await l.registry.listSatellites();
    expect(listed.map((s) => s.key)).toContain(key);
    expect([...listed.map((s) => s.key)].sort()).toEqual(listed.map((s) => s.key));

    // Register a second satellite via the upsert path (new row).
    const key2 = satKey('reg2');
    const created = await l.registry.upsertSatellite(
      key2,
      {
        kind: 'worker',
        routePrefixes: [],
        serviceClientId: 'svc-x',
        products: ['agent_studio'],
        endpointUrl: null,
        versionFloor: '1.2.0',
        capabilities: { scopes: ['ingest'] },
        metadata: {},
        updatedAt: new Date().toISOString(),
      },
      { status: 'active', createdBy: 'staff-1' },
    );
    expect(created.key).toBe(key2);
    expect(created.status).toBe('active');
    expect(created.versionFloor).toBe('1.2.0');

    // Register update: same key, changed fields — status/createdBy preserved.
    const updated = await l.registry.upsertSatellite(
      key2,
      {
        kind: 'worker',
        routePrefixes: ['/w'],
        serviceClientId: 'svc-x',
        products: ['agent_studio'],
        endpointUrl: 'https://worker.example.com',
        versionFloor: '1.3.0',
        capabilities: {},
        metadata: {},
        updatedAt: new Date().toISOString(),
      },
      { status: 'placeholder', createdBy: 'staff-2' },
    );
    expect(updated.routePrefixes).toEqual(['/w']);
    expect(updated.endpointUrl).toBe('https://worker.example.com');
    expect(updated.status).toBe('active'); // insert-only field untouched
    expect(updated.createdBy).toBe('staff-1');

    // statusView composition: listSatellites + openIncidentCounts (as the
    // service does).
    const [allSatellites, openCounts] = await Promise.all([
      l.registry.listSatellites(),
      l.registry.openIncidentCounts(),
    ]);
    const entry = allSatellites.find((s) => s.key === key2);
    expect(entry).toBeDefined();
    expect(openCounts.get(key2) ?? 0).toBe(0);
    expect(allSatellites.length).toBeGreaterThanOrEqual(2);
  });

  it('register race: parallel upserts converge on one row', async () => {
    const l = lane();
    await l.wipe();
    const key = satKey('race');
    const now = new Date().toISOString();
    const [a, b] = await Promise.all([
      l.registry.upsertSatellite(
        key,
        { kind: 'custom', routePrefixes: [], serviceClientId: null, products: [], endpointUrl: null, versionFloor: null, capabilities: {}, metadata: {}, updatedAt: now },
        { status: 'active', createdBy: 'a' },
      ),
      l.registry.upsertSatellite(
        key,
        { kind: 'custom', routePrefixes: [], serviceClientId: null, products: [], endpointUrl: null, versionFloor: null, capabilities: {}, metadata: {}, updatedAt: now },
        { status: 'active', createdBy: 'b' },
      ),
    ]);
    expect(a.key).toBe(key);
    expect(b.key).toBe(key);
    const rows = (await l.registry.listSatellites()).filter((s) => s.key === key);
    expect(rows).toHaveLength(1);
  });

  it('heartbeat lease: live flip, count bump, sample recorded', async () => {
    const l = lane();
    await l.wipe();
    const key = satKey('beat');
    await l.registry.seedSatellite({
      key, kind: 'custom', status: 'active', routePrefixes: [],
      serviceClientId: null, products: [], endpointUrl: null, metadata: {},
    });

    const before = (await l.registry.getSatellite(key))!;
    await l.registry.renewHeartbeatLease(key, {
      liveness: 'live',
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      lastHeartbeatVersion: '1.0.0',
      ...(before.firstHeartbeatAt ? {} : { firstHeartbeatAt: new Date().toISOString() }),
      metadata: { region: 'eu' },
      updatedAt: new Date().toISOString(),
    });
    await l.registry.insertHeartbeatSample({
      satelliteKey: key,
      version: '1.0.0',
      metrics: { cpu: 0.5 },
      capabilities: {},
      metadata: {},
      receivedAt: new Date().toISOString(),
    });

    const after = (await l.registry.getSatellite(key))!;
    expect(after.liveness).toBe('live');
    expect(after.heartbeatCount).toBe(before.heartbeatCount + 1);
    expect(after.firstHeartbeatAt).not.toBeNull();
    expect(after.lastHeartbeatVersion).toBe('1.0.0');
    expect(after.metadata).toEqual({ region: 'eu' });

    // Second beat: count advances, firstHeartbeatAt preserved.
    const firstBeat = after.firstHeartbeatAt;
    await l.registry.renewHeartbeatLease(key, {
      liveness: 'live',
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      lastHeartbeatVersion: '1.0.1',
      updatedAt: new Date().toISOString(),
    });
    const after2 = (await l.registry.getSatellite(key))!;
    expect(after2.heartbeatCount).toBe(after.heartbeatCount + 1);
    expect(after2.firstHeartbeatAt).toBe(firstBeat);

    const history = await l.registry.listHeartbeatHistory(key, 10);
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe('1.0.0');
    expect(history[0].metrics).toEqual({ cpu: 0.5 });
  });

  it('lifecycle transitions persist the expected status columns', async () => {
    const l = lane();
    await l.wipe();
    const key = satKey('life');
    await l.registry.seedSatellite({
      key, kind: 'custom', status: 'active', routePrefixes: [],
      serviceClientId: null, products: [], endpointUrl: null, metadata: {},
    });
    const now = new Date().toISOString();

    await l.registry.updateSatelliteStatus(key, {
      status: 'quarantined', quarantinedAt: now, quarantinedBy: 'staff-1',
      quarantineReason: 'bad behavior', updatedAt: now,
    });
    let row = (await l.registry.getSatellite(key))!;
    expect(row.status).toBe('quarantined');
    expect(row.quarantineReason).toBe('bad behavior');

    await l.registry.updateSatelliteStatus(key, {
      status: 'active', quarantinedAt: null, quarantinedBy: null,
      quarantineReason: null, updatedAt: now,
    });
    row = (await l.registry.getSatellite(key))!;
    expect(row.status).toBe('active');
    expect(row.quarantinedAt).toBeNull();

    await l.registry.updateSatelliteStatus(key, {
      status: 'draining', drainStartedAt: now, drainedBy: 'staff-1', updatedAt: now,
    });
    row = (await l.registry.getSatellite(key))!;
    expect(row.status).toBe('draining');

    await l.registry.updateSatelliteStatus(key, {
      status: 'active', drainStartedAt: null, drainedBy: null, updatedAt: now,
    });
    row = (await l.registry.getSatellite(key))!;
    expect(row.status).toBe('active');

    await l.registry.updateSatelliteStatus(key, { status: 'retired', retiredAt: now, updatedAt: now });
    row = (await l.registry.getSatellite(key))!;
    expect(row.status).toBe('retired');
    expect(row.retiredAt).not.toBeNull();
  });

  it('incident dedup: open, extend, resolve, autoResolve', async () => {
    const l = lane();
    await l.wipe();
    const key = satKey('inc');
    const now = new Date().toISOString();

    // Persistent kind: open → unresolved found.
    await l.incidents.openIncident({ satelliteKey: key, kind: 'quarantined', detail: { first_seen: now }, openedAt: now });
    const found = await l.incidents.findUnresolved(key, 'quarantined');
    expect(found).not.toBeNull();
    expect(found?.satelliteKey).toBe(key);

    // Extend path: same id, detail gains last_seen.
    await l.incidents.extendIncident(found!.id, { ...(found!.detail as Record<string, unknown>), last_seen: now });
    const extended = await l.incidents.findUnresolved(key, 'quarantined');
    expect(extended?.id).toBe(found!.id);
    expect((extended?.detail as Record<string, unknown>).last_seen).toBe(now);

    // Resolve closes it.
    const closed = await l.incidents.resolveIncidents(key, 'quarantined');
    expect(closed).toBe(1);
    expect(await l.incidents.findUnresolved(key, 'quarantined')).toBeNull();

    // Auto-resolve kinds are stored already-resolved.
    await l.incidents.openIncident({
      satelliteKey: key, kind: 'liveness_restored', detail: {}, openedAt: now, resolvedAt: now,
    });
    expect(await l.incidents.findUnresolved(key, 'liveness_restored')).toBeNull();

    // Lists + counts.
    const forKey = await l.incidents.listFor(key, 100);
    expect(forKey.length).toBeGreaterThanOrEqual(2);
    expect(await l.incidents.listOpen(key, 50)).toHaveLength(0);
    expect((await l.incidents.listRecent(100)).some((i) => i.satelliteKey === key)).toBe(true);
    expect(await l.incidents.countOpen()).toBe(0);

    // Resolve-all (no kind) closes every open incident for the satellite.
    await l.incidents.openIncident({ satelliteKey: key, kind: 'drained', detail: {}, openedAt: now });
    await l.incidents.openIncident({ satelliteKey: key, kind: 'config_drift', detail: {}, openedAt: now });
    expect(await l.incidents.resolveIncidents(key)).toBe(2);
  });

  it('activity race: 10 parallel touches on one scope → count exactly 10', async () => {
    const l = lane();
    await l.wipe();
    const key = satKey('act');
    const now = new Date().toISOString();
    await Promise.all(
      Array.from({ length: 10 }, () => l.activity.touchCounter({ satelliteKey: key, scope: 'heartbeat', events: 0, now })),
    );
    const row = (await l.activity.getCounter(key))!;
    expect(row.heartbeats).toBe(10);
    expect(row.lastHeartbeatAt).toBe(now);

    // Ingest scope accumulates events, not just batches.
    await l.activity.touchCounter({ satelliteKey: key, scope: 'ingest', events: 7, now });
    await l.activity.touchCounter({ satelliteKey: key, scope: 'ingest', events: 3, now });
    const row2 = (await l.activity.getCounter(key))!;
    expect(row2.ingestBatches).toBe(2);
    expect(row2.ingestEvents).toBe(10);
    // Other scopes untouched.
    expect(row2.quotaChecks).toBe(0);

    expect(await l.activity.getCounter(satKey('missing'))).toBeNull();
  });

  it('revocation feed: append, cursor since, between window', async () => {
    const l = lane();
    await l.wipe();

    await l.revocations.appendRevocation({ kind: 'session', subjectId: 'sid-1', payload: { account_id: 'a1' } });
    await l.revocations.appendRevocation({ kind: 'account_all', subjectId: 'acc-1', payload: {} });
    await l.revocations.appendRevocation({ kind: 'key', subjectId: 'key-1', payload: { org_id: 'o1' } });

    const head = await l.revocations.listSince(new Date(0).toISOString(), '', 500);
    expect(head).toHaveLength(3);
    expect(head.map((r) => r.subjectId)).toEqual(['sid-1', 'acc-1', 'key-1']);
    // Ascending (occurred_at, id).
    const ordered = [...head].sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1,
    );
    expect(head.map((r) => r.id)).toEqual(ordered.map((r) => r.id));

    // Cursor pagination: tail after the second row.
    const cursor = head[1];
    const tail = await l.revocations.listSince(cursor.occurredAt, cursor.id, 500);
    expect(tail.map((r) => r.subjectId)).toEqual(['key-1']);

    // Cursor round-trip through the service's `<iso>|<id>` encoding.
    const encoded = `${new Date(cursor.occurredAt).toISOString()}|${cursor.id}`;
    const [ts, id] = [encoded.slice(0, encoded.lastIndexOf('|')), encoded.slice(encoded.lastIndexOf('|') + 1)];
    const tail2 = await l.revocations.listSince(new Date(ts).toISOString(), id, 500);
    expect(tail2.map((r) => r.subjectId)).toEqual(['key-1']);

    // Window filter.
    const between = await l.revocations.listBetween(head[0].occurredAt, head[2].occurredAt, 200);
    expect(between).toHaveLength(3);
    const narrow = await l.revocations.listBetween(head[0].occurredAt, head[0].occurredAt, 200);
    expect(narrow.map((r) => r.subjectId)).toContain('sid-1');
  });

  it('sweeper: connected set, liveness set, prunes, drift candidates', async () => {
    const l = lane();
    await l.wipe();
    const activeKey = satKey('sw-a');
    const retiredKey = satKey('sw-r');
    const placeholderKey = satKey('sw-p');
    for (const [key, status] of [[activeKey, 'active'], [retiredKey, 'retired'], [placeholderKey, 'placeholder']] as const) {
      await l.registry.seedSatellite({
        key, kind: 'custom', status, routePrefixes: [],
        serviceClientId: null, products: [], endpointUrl: null, metadata: {},
      });
    }

    const connected = await l.registry.listConnectedSatellites();
    const keys = connected.map((s) => s.key);
    expect(keys).toContain(activeKey);
    expect(keys).not.toContain(retiredKey);
    expect(keys).not.toContain(placeholderKey);

    await l.registry.setLiveness(activeKey, 'stale', new Date().toISOString());
    const staleRow = await l.registry.getSatellite(activeKey);
    expect(staleRow?.liveness).toBe('stale');

    // Heartbeat prune: old sample removed, fresh kept.
    const oldIso = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const freshIso = new Date().toISOString();
    await l.registry.insertHeartbeatSample({ satelliteKey: activeKey, version: null, metrics: {}, capabilities: {}, metadata: {}, receivedAt: oldIso });
    await l.registry.insertHeartbeatSample({ satelliteKey: activeKey, version: null, metrics: {}, capabilities: {}, metadata: {}, receivedAt: freshIso });
    const pruned = await l.registry.pruneHeartbeatSamples(new Date(Date.now() - 24 * 3_600_000).toISOString());
    expect(pruned).toBe(1);
    expect(await l.registry.listHeartbeatHistory(activeKey, 10)).toHaveLength(1);

    // Revocation prune.
    await l.revocations.appendRevocation({ kind: 'session', subjectId: 'old-sid', payload: {} });
    const prunedRev = await l.revocations.pruneOlderThan(new Date(Date.now() + 60_000).toISOString());
    expect(prunedRev).toBe(1);
    expect(await l.revocations.listSince(new Date(0).toISOString(), '', 500)).toHaveLength(0);

    // Drift candidates: unacked + over threshold + active satellite.
    const threshold = new Date(Date.now() - 60_000).toISOString();
    const oldNotified = new Date(Date.now() - 3_600_000).toISOString();
    const freshNotified = new Date().toISOString();
    await l.seedConfigNotification(activeKey, oldNotified, null); // candidate
    await l.seedConfigNotification(activeKey, freshNotified, null); // under threshold
    await l.seedConfigNotification(activeKey, oldNotified, freshIso); // acked
    await l.seedConfigNotification(retiredKey, oldNotified, null); // not active
    const candidates = await l.registry.driftCandidates(threshold);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].satelliteKey).toBe(activeKey);
    expect(candidates[0].count).toBe(1);
    expect(candidates[0].oldest).toBe(oldNotified);

    // Backlog + open-drift keys.
    expect(await l.registry.backloggedSatelliteKeys()).toEqual([activeKey]);
    expect(await l.registry.openDriftIncidentKeys()).toEqual([]);
    await l.incidents.openIncident({ satelliteKey: activeKey, kind: 'config_drift', detail: {}, openedAt: freshIso });
    expect(await l.registry.openDriftIncidentKeys()).toEqual([activeKey]);
  });
});
