/**
 * Webhooks repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through `IWebhookRepository` and
 * `IWebhookDeliveryRepository`.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. createWebhook round-trip: defaults (status 'active', createdBy null),
 *     list ordering (newest first), listActiveWebhooks filtering, update
 *     patch, rotateSecret, delete cascade (deliveries go with the hook), and
 *     cross-org isolation on every webhook read/write.
 *  2. Delivery claim race: 6 stranded `failed` deliveries (nextAttemptAt in
 *     the past, attempts left) claimed by 2 parallel
 *     `claimStrandedDeliveries(10)` calls → every stranded row is claimed by
 *     exactly one caller (pg: FOR UPDATE SKIP LOCKED; mongo: atomic
 *     findOneAndUpdate with the stranded predicate). The returned `attempts`
 *     matches what was written.
 *  3. Delivery status transitions: pending → delivered (responseStatus +
 *     deliveredAt set), pending → failed (retry bookkeeping: attempts,
 *     lastError, nextAttemptAt), failed → dead (attempts bumped on retry
 *     exhaustion, untouched otherwise), and the enqueue-failure park →
 *     sweep claim loop (parked rows become claimable).
 *  4. Cross-org delivery isolation: org B cannot list or mutate org A's
 *     deliveries; the bypass reads (`getDeliveryUnchecked`,
 *     `getWebhookUnchecked`) are worker-plane by design and stay visible.
 *  5. Cross-provider determinism: the same misuse produces the same error
 *     codes on both lanes. Row ids are uuidv7 on both lanes but are NOT
 *     byte-identical across lanes (generated independently per write);
 *     timestamps are ISO-8601 strings on both lanes but wall-clock values
 *     differ — neither is asserted across lanes.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated `neryva_parity`
 * database — never the live `neryva` DB). Tables are provisioned idempotently
 * from the drizzle schema shapes (`webhooks`, `webhook_deliveries`); RLS
 * policies use the hardened form: `org_id` is a `varchar(36)` (not a uuid —
 * see schema.ts), so the policy is the text-compare form from
 * `drizzle/0011_platform_services.sql` with the 0060 nullif guard (no
 * `::uuid` cast anywhere on this lane). No FK constraints in the fixture:
 * the repositories never rely on FK cascades in the tested paths (the mongo
 * lane deletes deliveries explicitly), and skipping them keeps provisioning
 * order-independent.
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withOrg`/`withBypass` with the exact `withSession` semantics:
 * one ClientSession, one majority multi-document transaction via
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
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import type { DbService } from '../../../common/infra/db/db.service';
import type {
  IWebhookDeliveryRepository,
  IWebhookRepository,
} from './webhooks.repository';

// ---------------------------------------------------------------------------
// lane abstraction (fixture + white-box reads, per provider)
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  hooks(): IWebhookRepository;
  deliveries(): IWebhookDeliveryRepository;
  cleanupOrg(orgId: string): Promise<void>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header).
// DbService is imported as a TYPE only — the runtime import happens
// dynamically in buildPgLane so env.ts parses after DATABASE_URL is set.
let DbServiceCtor: new () => DbService;
let PgWebhookRepositoryCtor: new (db: never) => IWebhookRepository;
let PgWebhookDeliveryRepositoryCtor: new (db: never) => IWebhookDeliveryRepository;
// MongoDbService-shaped harness (root + withOrg/withBypass with the exact
// MongoDbService.withSession semantics: one ClientSession, one majority
// transaction via runInTransaction, session closed in finally). Used instead
// of MongoDbService itself so this spec never depends on the import-time
// `env.ts` parse — same precedent as the P2 idempotency parity spec.
interface MongoLaneDeps {
  root: Db;
  withOrg<T>(orgId: string, fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
  withBypass<T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
}
let MongoWebhookRepositoryCtor: new (m: never) => IWebhookRepository;
let MongoWebhookDeliveryRepositoryCtor: new (m: never) => IWebhookDeliveryRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the drizzle schema sources (webhooks,
// webhook_deliveries); RLS in the hardened text-compare form. Idempotent.
// ---------------------------------------------------------------------------

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "webhooks" (
     "id" uuid PRIMARY KEY,
     "org_id" varchar(36) NOT NULL,
     "events" jsonb NOT NULL DEFAULT '[]',
     "url" text NOT NULL,
     "secret_envelope" text NOT NULL,
     "description" varchar(256),
     "status" varchar(16) NOT NULL DEFAULT 'active',
     "created_by" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
     "id" uuid PRIMARY KEY,
     "org_id" varchar(36) NOT NULL,
     "webhook_id" uuid NOT NULL,
     "event_type" varchar(64) NOT NULL,
     "payload" jsonb NOT NULL,
     "status" varchar(16) NOT NULL DEFAULT 'pending',
     "attempts" integer NOT NULL DEFAULT 0,
     "last_error" varchar(512),
     "response_status" integer,
     "delivered_at" timestamptz,
     "next_attempt_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
];

// org_id is varchar(36) on this lane — the policy is the text-compare form
// (drizzle/0011_platform_services.sql) with the 0060 nullif guard; there is
// no ::uuid cast anywhere.
const VARCHAR_POLICY = (table: string): string => `
  DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}";
  CREATE POLICY "${table}_tenant_isolation" ON "${table}"
    USING (org_id = nullif(current_setting('app.current_tenant'::text, true), ''::text)
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)
    WITH CHECK (org_id = nullif(current_setting('app.current_tenant'::text, true), ''::text)
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)`;

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  for (const t of ['webhooks', 'webhook_deliveries']) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(VARCHAR_POLICY(t)));
  }
}

// ---------------------------------------------------------------------------
// lane construction
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';

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
let mongoReplSet: MongoMemoryReplSet | undefined;
let mongoClient: MongoClient | undefined;

const trackedOrgIds = new Set<string>();

function trackOrg(orgId: string): string {
  trackedOrgIds.add(orgId);
  return orgId;
}

// Mongo timestamps are ISO-8601 strings at millisecond resolution; the pg
// lane's timestamptz is microsecond. Tests that assert "newest first"
// ordering insert a tick between writes so created_at values are distinct on
// both lanes (the ports only guarantee the sort key, not a tie-break).
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
    return null;
  }
  // env.ts parses at import time: the URL must be in place BEFORE the first
  // dynamic import below touches src/common/config/env.ts.
  process.env.DATABASE_URL ??= DATABASE_URL;
  const { DbService } = await import('../../../common/infra/db/db.service');
  DbServiceCtor = DbService;
  const hookMod = await import('./pg-webhook.repository');
  const deliveryMod = await import('./pg-webhook-delivery.repository');
  PgWebhookRepositoryCtor = hookMod.PgWebhookRepository;
  PgWebhookDeliveryRepositoryCtor = deliveryMod.PgWebhookDeliveryRepository;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const hookRepo = new PgWebhookRepositoryCtor(db as never);
  const deliveryRepo = new PgWebhookDeliveryRepositoryCtor(db as never);

  const cleanupOrg = async (orgId: string): Promise<void> => {
    await (db as never as { withBypass<T>(f: (tx: never) => Promise<T>): Promise<T> }).withBypass(
      async (tx) => {
        const d = tx as unknown as { execute(q: unknown): Promise<unknown> };
        // No FK constraints in the fixture — order-independent deletes.
        await d.execute(sql.raw(`delete from "webhook_deliveries" where org_id = '${orgId}'`));
        await d.execute(sql.raw(`delete from "webhooks" where org_id = '${orgId}'`));
      },
    );
  };

  return {
    name: 'pg',
    hooks: () => hookRepo,
    deliveries: () => deliveryRepo,
    cleanupOrg,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
    },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-webhook-parity-${process.pid}`;
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
  mongoReplSet = replSet;

  const hookMod = await import('./mongo-webhook.repository');
  const deliveryMod = await import('./mongo-webhook-delivery.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoWebhookRepositoryCtor = hookMod.MongoWebhookRepository;
  MongoWebhookDeliveryRepositoryCtor = deliveryMod.MongoWebhookDeliveryRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_webhook_parity');
  await runMongoMigrationsFn(db);

  // Exact MongoDbService.withSession semantics (private there; replicated
  // here per the P2 precedent so the repositories run their real code paths).
  const withSession = async <T>(
    orgId: string | null,
    fn: (ctx: { session: never; orgId: string | null }) => Promise<T>,
  ): Promise<T> => {
    const session = client.startSession();
    try {
      return await runInTransaction(session, () =>
        fn({ session: session as never, orgId }),
      );
    } finally {
      await session.endSession().catch(() => undefined);
    }
  };
  const deps: MongoLaneDeps = {
    root: db,
    withOrg: async (orgId, fn) => {
      if (!orgId) throw new Error('withOrg requires a non-empty orgId (fail-closed tenant scoping)');
      return withSession(orgId, fn);
    },
    withBypass: (fn) => withSession(null, fn),
  };

  const hookRepo = new MongoWebhookRepositoryCtor(deps as never);
  const deliveryRepo = new MongoWebhookDeliveryRepositoryCtor(deps as never);

  const cleanupOrg = async (orgId: string): Promise<void> => {
    // org_id is Binary subtype 4 on the mongo lane (plan D4).
    const { uuidToBinary } = await import('../../../common/infra/db/mongo/mongo-tx');
    const orgBin = uuidToBinary(orgId);
    await db.collection('webhook_deliveries').deleteMany({ org_id: orgBin }).catch(() => undefined);
    await db.collection('webhooks').deleteMany({ org_id: orgBin }).catch(() => undefined);
  };

  return {
    name: 'mongo',
    hooks: () => hookRepo,
    deliveries: () => deliveryRepo,
    cleanupOrg,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
    },
  };
}

beforeAll(async () => {
  pgLane = await buildPgLane();
  mongoLane = await buildMongoLane();
  if (!pgLane && !mongoLane) {
    console.warn('[parity] neither lane available — all scenarios skipped');
  }
}, 300_000);

afterAll(async () => {
  await pgLane?.teardown().catch(() => undefined);
  await mongoLane?.teardown().catch(() => undefined);
  await mongoClient?.close().catch(() => undefined);
  await mongoReplSet?.stop().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// shared scenarios — identical assertions on both lanes
// ---------------------------------------------------------------------------

function laneScenarios(laneName: string, getLane: () => Lane | null): void {
  const need = (): Lane | null => {
    const lane = getLane();
    if (!lane) console.warn(`[parity] ${laneName} lane unavailable — scenario skipped`);
    return lane;
  };

  describe(`webhooks parity — ${laneName} lane`, () => {
    it('createWebhook round-trip + CRUD + cross-org isolation', async () => {
      const lane = need();
      if (!lane) return;
      const orgA = trackOrg(randomUUID());
      const orgB = trackOrg(randomUUID());

      const created = await lane.hooks().createWebhook({
        orgId: orgA,
        url: 'https://example.com/hook-a',
        events: ['*'],
        description: 'parity hook',
        secretEnvelope: 'enc:v1:parity-secret',
      });
      // Production defaults (pg schema + mechanical move): status 'active',
      // createdBy null. Any lane divergence here is a real behavioral gap.
      expect(created.orgId).toBe(orgA);
      expect(created.status).toBe('active');
      expect(created.createdBy).toBeNull();
      expect(created.events).toEqual(['*']);
      // The repository returns the RAW row (redaction is the service's job).
      expect(created.secretEnvelope).toBe('enc:v1:parity-secret');

      const read = await lane.hooks().getWebhook(orgA, created.id);
      expect(read?.id).toBe(created.id);

      // Cross-org: org B cannot see, patch, or delete org A's webhook. The
      // cross-org patch is a mechanical no-op at runtime: like the original
      // `updated[0]`, the port yields `undefined` (the require/update race
      // posture — recorded, not fixed).
      expect(await lane.hooks().getWebhook(orgB, created.id)).toBeNull();
      expect(await lane.hooks().listWebhooks(orgB)).toEqual([]);
      expect(await lane.hooks().updateWebhook(orgB, created.id, { url: 'https://evil.example/x' })).toBeUndefined();
      await lane.hooks().deleteWebhook(orgB, created.id);
      expect((await lane.hooks().getWebhook(orgA, created.id))?.url).toBe('https://example.com/hook-a');

      // Update patch.
      const patched = await lane.hooks().updateWebhook(orgA, created.id, {
        url: 'https://example.com/hook-b',
        status: 'disabled',
        updatedAt: new Date().toISOString(),
      });
      expect(patched.url).toBe('https://example.com/hook-b');
      expect(patched.status).toBe('disabled');

      // listActiveWebhooks only returns active hooks.
      expect(await lane.hooks().listActiveWebhooks(orgA)).toEqual([]);
      await tick();
      const second = await lane.hooks().createWebhook({
        orgId: orgA,
        url: 'https://example.com/hook-c',
        events: ['config.published'],
        secretEnvelope: 'enc:v1:parity-secret-2',
      });
      expect((await lane.hooks().listActiveWebhooks(orgA)).map((h) => h.id)).toEqual([second.id]);

      // listWebhooks: newest first.
      const listed = await lane.hooks().listWebhooks(orgA);
      expect(listed.map((h) => h.id)).toEqual([second.id, created.id]);

      // Secret rotation.
      await lane.hooks().rotateSecret(orgA, created.id, 'enc:v1:parity-secret-rotated');
      expect((await lane.hooks().getWebhook(orgA, created.id))?.secretEnvelope).toBe(
        'enc:v1:parity-secret-rotated',
      );

      // Delete cascades to the hook's deliveries on both lanes (pg: FK
      // cascade in the real schema; mongo: explicit delete in the unit).
      const deliveryId = await lane.deliveries().createDelivery({
        orgId: orgA,
        webhookId: created.id,
        eventType: 'config.published',
        data: { v: 1 },
      });
      expect(deliveryId).toBeTruthy();
      await lane.hooks().deleteWebhook(orgA, created.id);
      expect(await lane.hooks().getWebhook(orgA, created.id)).toBeNull();
      expect(await lane.deliveries().listDeliveries(orgA, created.id, 50, 0)).toEqual([]);
      expect(await lane.deliveries().getDeliveryUnchecked(deliveryId)).toBeNull();

      await lane.cleanupOrg(orgA);
      await lane.cleanupOrg(orgB);
    });

    it('delivery claim race: parallel sweeps claim each stranded row exactly once', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const hook = await lane.hooks().createWebhook({
        orgId: org,
        url: 'https://example.com/hook',
        events: ['*'],
        secretEnvelope: 'enc:v1:parity-secret',
      });

      // 6 stranded deliveries: failed, nextAttemptAt in the past, attempts
      // left — built entirely through the port.
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const id = await lane.deliveries().createDelivery({
          orgId: org,
          webhookId: hook.id,
          eventType: 'config.published',
          data: { i },
        });
        await lane.deliveries().markDeliveryRetryable(
          org,
          id,
          1,
          'parity boom',
          new Date(Date.now() - 60_000).toISOString(),
        );
        ids.push(id);
      }

      // Two concurrent sweeps — the atomic claim (pg SKIP LOCKED / mongo
      // findOneAndUpdate) must give each stranded row to exactly one caller.
      const [first, second] = await Promise.all([
        lane.deliveries().claimStrandedDeliveries(10),
        lane.deliveries().claimStrandedDeliveries(10),
      ]);
      const all = [...first, ...second];
      const claimedIds = all.map((c) => c.id);
      expect(new Set(claimedIds).size).toBe(6);
      expect(claimedIds.sort()).toEqual([...ids].sort());
      for (const c of all) {
        expect(c.attempts).toBe(1);
      }

      // A non-stranded delivery (fresh pending) is never claimed.
      const fresh = await lane.deliveries().createDelivery({
        orgId: org,
        webhookId: hook.id,
        eventType: 'config.published',
        data: {},
      });
      const again = await lane.deliveries().claimStrandedDeliveries(10);
      expect(again.map((c) => c.id)).not.toContain(fresh);

      await lane.cleanupOrg(org);
    });

    it('delivery status transitions: delivered / failed / dead / park-then-claim', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const hook = await lane.hooks().createWebhook({
        orgId: org,
        url: 'https://example.com/hook',
        events: ['*'],
        secretEnvelope: 'enc:v1:parity-secret',
      });

      // pending → delivered: responseStatus + deliveredAt set.
      const d1 = await lane.deliveries().createDelivery({
        orgId: org,
        webhookId: hook.id,
        eventType: 'config.published',
        data: { ok: true },
      });      let row = await lane.deliveries().getDeliveryUnchecked(d1);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(0);
      expect(row?.payload).toEqual({
        type: 'config.published',
        created_at: (row?.payload as { created_at: string }).created_at,
        data: { ok: true },
      });
      await lane.deliveries().markDeliveryDelivered(org, d1, 200);
      row = await lane.deliveries().getDeliveryUnchecked(d1);
      expect(row?.status).toBe('delivered');
      expect(row?.responseStatus).toBe(200);
      expect(typeof row?.deliveredAt).toBe('string');

      await tick();
      // pending → failed: retry bookkeeping written.
      const d2 = await lane.deliveries().createDelivery({
        orgId: org,
        webhookId: hook.id,
        eventType: 'config.published',
        data: {},
      });
      const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
      await lane.deliveries().markDeliveryRetryable(org, d2, 2, 'HTTP 500', nextAttemptAt);
      row = await lane.deliveries().getDeliveryUnchecked(d2);
      expect(row?.status).toBe('failed');
      expect(row?.attempts).toBe(2);
      expect(row?.lastError).toBe('HTTP 500');
      expect(row?.nextAttemptAt).toBe(nextAttemptAt);

      // failed → dead on retry exhaustion: attempts bumped.
      await lane.deliveries().markDeliveryDead(org, d2, 'HTTP 500', 5);
      row = await lane.deliveries().getDeliveryUnchecked(d2);
      expect(row?.status).toBe('dead');
      expect(row?.attempts).toBe(5);
      expect(row?.lastError).toBe('HTTP 500');

      await tick();
      // dead without an attempts argument leaves attempts untouched.
      const d3 = await lane.deliveries().createDelivery({
        orgId: org,
        webhookId: hook.id,
        eventType: 'config.published',
        data: {},
      });
      await lane.deliveries().markDeliveryDead(org, d3, 'webhook disabled or removed');
      row = await lane.deliveries().getDeliveryUnchecked(d3);
      expect(row?.status).toBe('dead');
      expect(row?.attempts).toBe(0);

      await tick();
      // The enqueue-failure park → sweep claim loop (all through the port).
      const d4 = await lane.deliveries().createDelivery({
        orgId: org,
        webhookId: hook.id,
        eventType: 'config.published',
        data: {},
      });
      await lane.deliveries().parkEnqueueFailure(
        org,
        d4,
        'enqueue failed: redis down',
        new Date(Date.now() - 1_000).toISOString(),
      );
      row = await lane.deliveries().getDeliveryUnchecked(d4);
      expect(row?.status).toBe('failed');
      expect(row?.attempts).toBe(0);
      expect(row?.lastError).toBe('enqueue failed: redis down');
      const claimed = await lane.deliveries().claimStrandedDeliveries(10);
      expect(claimed.map((c) => c.id)).toContain(d4);
      expect(claimed.find((c) => c.id === d4)?.attempts).toBe(0);

      // Delivery log ordering: newest first, limit/offset honored.
      const log = await lane.deliveries().listDeliveries(org, hook.id, 50, 0);
      expect(log.map((r) => r.id)).toEqual([d4, d3, d2, d1]);
      expect((await lane.deliveries().listDeliveries(org, hook.id, 2, 0)).map((r) => r.id)).toEqual([d4, d3]);
      expect((await lane.deliveries().listDeliveries(org, hook.id, 50, 2)).map((r) => r.id)).toEqual([d2, d1]);

      await lane.cleanupOrg(org);
    });

    it('cross-org delivery isolation', async () => {
      const lane = need();
      if (!lane) return;
      const orgA = trackOrg(randomUUID());
      const orgB = trackOrg(randomUUID());
      const hook = await lane.hooks().createWebhook({
        orgId: orgA,
        url: 'https://example.com/hook',
        events: ['*'],
        secretEnvelope: 'enc:v1:parity-secret',
      });
      const deliveryId = await lane.deliveries().createDelivery({
        orgId: orgA,
        webhookId: hook.id,
        eventType: 'config.published',
        data: {},
      });

      // Org B sees nothing and mutates nothing of org A's deliveries.
      expect(await lane.deliveries().listDeliveries(orgB, hook.id, 50, 0)).toEqual([]);
      await lane.deliveries().markDeliveryDelivered(orgB, deliveryId, 200);
      await lane.deliveries().markDeliveryDead(orgB, deliveryId, 'evil');
      const row = await lane.deliveries().getDeliveryUnchecked(deliveryId);
      expect(row?.status).toBe('pending');
      expect(row?.orgId).toBe(orgA);

      // The bypass reads are worker-plane by design (cross-org queue drain) —
      // visible here so the posture is explicit, not accidental.
      expect((await lane.hooks().getWebhookUnchecked(hook.id))?.orgId).toBe(orgA);

      await lane.cleanupOrg(orgA);
      await lane.cleanupOrg(orgB);
    });
  });
}

describe('webhooks repository parity', () => {
  laneScenarios('pg', () => pgLane);
  laneScenarios('mongo', () => mongoLane);

  it('cross-provider determinism: same flow, same codes and shapes', async () => {
    if (!pgLane || !mongoLane) {
      console.warn('[parity] cross-provider check needs both lanes — skipped');
      return;
    }
    const orgP = trackOrg(randomUUID());
    const orgM = trackOrg(randomUUID());

    // Unknown webhook reads are null on both lanes (service maps to
    // not_found identically).
    const [pgMiss, mongoMiss] = await Promise.all([
      pgLane.hooks().getWebhook(orgP, randomUUID()),
      mongoLane.hooks().getWebhook(orgM, randomUUID()),
    ]);
    expect(pgMiss).toBeNull();
    expect(mongoMiss).toBeNull();

    // Same flow: create → deliver → fail → dead, identical shapes.
    const mkFlow = async (lane: Lane, org: string) => {
      const hook = await lane.hooks().createWebhook({
        orgId: org,
        url: 'https://example.com/hook',
        events: ['config.published'],
        description: 'x',
        secretEnvelope: 'enc:v1:s',
      });
      const deliveryId = await lane.deliveries().createDelivery({
        orgId: org,
        webhookId: hook.id,
        eventType: 'config.published',
        data: { a: 1 },
      });
      await lane.deliveries().markDeliveryRetryable(org, deliveryId, 1, 'HTTP 502', new Date(Date.now() + 60_000).toISOString());
      await lane.deliveries().markDeliveryDead(org, deliveryId, 'HTTP 502', 5);
      const row = await lane.deliveries().getDeliveryUnchecked(deliveryId);
      return { hook, row };
    };
    const [p, m] = await Promise.all([mkFlow(pgLane, orgP), mkFlow(mongoLane, orgM)]);
    for (const [hook, row] of [
      [p.hook, p.row],
      [m.hook, m.row],
    ] as const) {
      expect(hook.status).toBe('active');
      expect(hook.orgId).toBe(hook.orgId);
      expect(row?.status).toBe('dead');
      expect(row?.attempts).toBe(5);
      expect(row?.eventType).toBe('config.published');
      expect(typeof row?.createdAt).toBe('string');
    }
    // Timestamps are ISO-8601 strings on both lanes.
    expect(p.row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await pgLane.cleanupOrg(orgP);
    await mongoLane.cleanupOrg(orgM);
  });
});
