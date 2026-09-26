/**
 * Config-publish repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised through `IConfigPublishRepository`,
 * `IConfigDraftRepository`, and `IConfigNotificationRepository`, plus the
 * service-level flows that own the conflict/rollback semantics
 * (`ConfigPublishService` with stubbed audit/events/satellites/manifests —
 * the repositories never see those).
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. publish round-trip + version increment: v1 then v2 on one key;
 *     `latest` returns v2, `version` drills into v1, `history` paginates
 *     newest-first with the total, `since` pages strictly-greater versions
 *     oldest-first with a continuation cursor, `bootstrap` returns every
 *     key's live version plus the cursor map.
 *  2. byte-identical republish → `conflict` (the service's pre-check against
 *     `latest.payloadHash`); a changed payload publishes cleanly.
 *  3. concurrent publishes serialize: 10 parallel publishes on ONE key →
 *     versions are exactly 1..10, no gaps, no duplicates, no lost writes
 *     (pg: the transaction-scoped advisory lock; mongo: the distributed
 *     lease). The unique (org, scope, product, version) index is present
 *     exactly as in the real DDL; on pg a plain UNIQUE does not treat NULL
 *     products as equal, so the lock/lease — not the index — is what
 *     serializes the org-wide (product NULL) path under test.
 *  4. draft save/list/delete: save (valid) → `getDraft` round-trips;
 *     re-save upserts in place (same id, new payload); `listDrafts`
 *     contains it; an invalid draft persists WITH its issue report but
 *     `publishDraft` refuses it; `publishDraft` on a valid draft publishes
 *     and drops the draft; `deleteDraft` removes it.
 *  5. rollback creates a NEW version restoring the old payload
 *     (`rollbackOf` set); rolling back to the already-live content →
 *     `conflict`; rolling back to a missing version → `not_found`.
 *  6. notification ledger: publish with an active satellite in the registry
 *     stub fans out exactly one row; `pendingFor` returns it; `ack` clears
 *     it; a duplicate fanout is a no-op (never a duplicate row);
 *     `deliveryStatus` reports per-satellite ack state.
 *  7. cross-org isolation: a second org sees none of the first org's
 *     versions, drafts, or history.
 *  8. cross-lane determinism: the same logical flow on both lanes yields
 *     the same error codes, the same version numbering, and the same
 *     rollback/new-version accounting. Row ids are uuidv7 (pg: v4
 *     `defaultRandom`, mongo: uuidv7) and are NOT byte-identical across
 *     lanes; timestamps are ISO-8601 strings on both lanes but wall-clock
 *     values differ — neither is asserted across lanes.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). Tables are
 * provisioned idempotently from the drizzle schema shapes (the module
 * `schema.ts`); RLS policies use the CURRENT hardened form (nullif guard),
 * adapted for the varchar(36) `org_id` tenant column. `config_notifications`
 * is platform-plane (no RLS), exactly as in drizzle/0007. No FK constraints
 * in the fixture: the repositories never rely on FK cascades in the tested
 * paths, and skipping them keeps provisioning order-independent (same
 * precedent as the P2 idempotency parity spec).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations` +
 * `ensureLeaseIndexes` (the publish path needs `mongo_leases`). The mongo
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
import type { Binary, Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { ApiError } from '../../../common/http/api-error';
import type { ConfigScope } from '../config-publish.schema';
import type { ConfigPublishService } from '../config-publish.service';
import type {
  IConfigDraftRepository,
  IConfigNotificationRepository,
  IConfigPublishRepository,
} from './config-publish.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  published(): IConfigPublishRepository;
  drafts(): IConfigDraftRepository;
  notifications(): IConfigNotificationRepository;
  /** Service over this lane's repositories; satellites stubbed per test. */
  service(satellites?: Array<{ key: string; status: string; products: string[] }>): ConfigPublishService;
  cleanupOrg(orgId: string): Promise<void>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header). DbService itself is
// imported dynamically in buildPgLane (not via a module-level binding) so
// env.ts parses only after DATABASE_URL is set; it is used directly there.
let ConfigPublishServiceCtor: new (...args: never[]) => ConfigPublishService;
let PgConfigPublishRepositoryCtor: new (db: never) => IConfigPublishRepository;
let PgConfigDraftRepositoryCtor: new (db: never) => IConfigDraftRepository;
let PgConfigNotificationRepositoryCtor: new (db: never) => IConfigNotificationRepository;
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
let MongoConfigPublishRepositoryCtor: new (m: never) => IConfigPublishRepository;
let MongoConfigDraftRepositoryCtor: new (m: never) => IConfigDraftRepository;
let MongoConfigNotificationRepositoryCtor: new (m: never) => IConfigNotificationRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;
let ensureLeaseIndexesFn: (db: Db) => Promise<void>;
let binUuidFn: (id: string) => Binary;

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SCOPE: ConfigScope = 'policy_set';

const payloadA = () => ({ name: 'baseline-a', rules: [] });
const payloadB = () => ({ name: 'baseline-b', rules: [] });
const payloadN = (n: number) => ({ name: `concurrent-${n}`, rules: [] });
/** Fails the policy_set schema: an input/block rule with no pattern. */
const invalidPayload = () => ({
  name: 'bad',
  rules: [{ name: 'r1', kind: 'input', action: 'block' }],
});

function buildService(
  published: IConfigPublishRepository,
  drafts: IConfigDraftRepository,
  notifications: IConfigNotificationRepository,
  satellites: Array<{ key: string; status: string; products: string[] }> = [],
): ConfigPublishService {
  return new ConfigPublishServiceCtor(
    published as never,
    drafts as never,
    notifications as never,
    { add: async () => undefined } as never, // AuditService
    { emit: async () => undefined } as never, // EventBus
    { list: async () => satellites } as never, // SatelliteRegistryService
    // ManifestRegistryService: every well-formed tag resolves (the
    // tag-format check itself still runs in the service).
    { get: () => ({}) } as never,
  );
}

function makeService(
  lane: Lane,
  satellites: Array<{ key: string; status: string; products: string[] }> = [],
): ConfigPublishService {
  return buildService(lane.published(), lane.drafts(), lane.notifications(), satellites);
}

async function publishVersion(
  lane: Lane,
  orgId: string,
  payload: unknown,
  satellites: Array<{ key: string; status: string; products: string[] }> = [],
  product: string | null = null,
) {
  return makeService(lane, satellites).publish({
    orgId,
    scope: SCOPE,
    product,
    payload,
    publishedBy: 'parity-operator',
  });
}

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the drizzle schema sources (+ eng-0016 for
// the NULLS NOT DISTINCT draft key); RLS in the hardened 0060 form adapted
// for the varchar(36) org_id tenant column. Idempotent.
// ---------------------------------------------------------------------------

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "published_configs" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "org_id" varchar(36) NOT NULL,
     "scope" varchar(32) NOT NULL,
     "product" varchar(64),
     "version" integer NOT NULL,
     "payload" jsonb NOT NULL,
     "payload_hash" varchar(64) NOT NULL,
     "notes" varchar(512),
     "rollback_of" integer,
     "published_by" varchar(128) NOT NULL,
     "published_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_published_configs_key_version" UNIQUE ("org_id", "scope", "product", "version")
   )`,
  `CREATE TABLE IF NOT EXISTS "config_drafts" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "org_id" varchar(36) NOT NULL,
     "scope" varchar(32) NOT NULL,
     "product" varchar(64),
     "payload" jsonb NOT NULL,
     "payload_hash" varchar(64) NOT NULL,
     "validation_status" varchar(16) NOT NULL,
     "validation_issues" jsonb,
     "notes" varchar(512),
     "created_by" varchar(128) NOT NULL,
     "updated_by" varchar(128) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  // platform-plane: no RLS (drizzle/0007).
  `CREATE TABLE IF NOT EXISTS "config_notifications" (
     "config_id" uuid NOT NULL,
     "satellite_key" varchar(64) NOT NULL,
     "notified_at" timestamptz NOT NULL DEFAULT now(),
     "acked_at" timestamptz,
     CONSTRAINT "pk_config_notifications" PRIMARY KEY ("config_id", "satellite_key")
   )`,
];

const HARDENED_VARCHAR_POLICY = (table: string): string => `
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
  // eng-0016: NULLS NOT DISTINCT so org-wide (product NULL) drafts upsert
  // per (org, scope) instead of inserting duplicates.
  await db.execute(
    sql.raw(
      `DROP INDEX IF EXISTS "uq_config_drafts_key";
       CREATE UNIQUE INDEX IF NOT EXISTS "uq_config_drafts_key"
         ON "config_drafts" ("org_id", "scope", "product") NULLS NOT DISTINCT`,
    ),
  );
  for (const t of ['published_configs', 'config_drafts']) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(HARDENED_VARCHAR_POLICY(t)));
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

const trackedOrgIds = new Set<string>();

function trackOrg(orgId: string): string {
  trackedOrgIds.add(orgId);
  return orgId;
}

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
    return null;
  }
  // env.ts parses at import time: the URL must be in place BEFORE the first
  // dynamic import below touches src/common/config/env.ts.
  process.env.DATABASE_URL ??= DATABASE_URL;
  const { DbService } = await import('../../../common/infra/db/db.service');
  const serviceMod = await import('../config-publish.service');
  ConfigPublishServiceCtor = serviceMod.ConfigPublishService;
  const pubMod = await import('./pg-config-publish.repository');
  const draftMod = await import('./pg-config-draft.repository');
  const notifMod = await import('./pg-config-notification.repository');
  PgConfigPublishRepositoryCtor = pubMod.PgConfigPublishRepository;
  PgConfigDraftRepositoryCtor = draftMod.PgConfigDraftRepository;
  PgConfigNotificationRepositoryCtor = notifMod.PgConfigNotificationRepository;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const publishedRepo = new PgConfigPublishRepositoryCtor(db as never);
  const draftRepo = new PgConfigDraftRepositoryCtor(db as never);
  const notifRepo = new PgConfigNotificationRepositoryCtor(db as never);

  const cleanupOrg = async (orgId: string): Promise<void> => {
    await db.withBypass(async (tx) => {
      const d = tx as unknown as { execute(q: unknown): Promise<unknown> };
      // No FK constraints in the fixture — order: notifications first.
      await d.execute(
        sql`delete from config_notifications where config_id in (select id from published_configs where org_id = ${orgId})`,
      );
      await d.execute(sql`delete from published_configs where org_id = ${orgId}`);
      await d.execute(sql`delete from config_drafts where org_id = ${orgId}`);
    });
  };

  return {
    name: 'pg',
    published: () => publishedRepo,
    drafts: () => draftRepo,
    notifications: () => notifRepo,
    service: (satellites) =>
      buildService(publishedRepo, draftRepo, notifRepo, satellites),
    cleanupOrg,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
    },
  };
}

let mongoReplSet: MongoMemoryReplSet | undefined;
let mongoClient: MongoClient | undefined;

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-cfgpub-parity-${process.pid}`;
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

  const serviceMod = await import('../config-publish.service');
  ConfigPublishServiceCtor = serviceMod.ConfigPublishService;
  const pubMod = await import('./mongo-config-publish.repository');
  const draftMod = await import('./mongo-config-draft.repository');
  const notifMod = await import('./mongo-config-notification.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const leaseMod = await import('../../../common/infra/db/mongo/concurrency/lease-lock');
  const docMod = await import('./mongo-documents');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoConfigPublishRepositoryCtor = pubMod.MongoConfigPublishRepository;
  MongoConfigDraftRepositoryCtor = draftMod.MongoConfigDraftRepository;
  MongoConfigNotificationRepositoryCtor = notifMod.MongoConfigNotificationRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;
  ensureLeaseIndexesFn = leaseMod.ensureLeaseIndexes;
  binUuidFn = docMod.binUuid;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_cfgpub_parity');
  await runMongoMigrationsFn(db);
  // The publish path needs the mongo_leases TTL collection (not part of the
  // baseline migration's collection registry); idempotent.
  await ensureLeaseIndexesFn(db);

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

  const publishedRepo = new MongoConfigPublishRepositoryCtor(deps as never);
  const draftRepo = new MongoConfigDraftRepositoryCtor(deps as never);
  const notifRepo = new MongoConfigNotificationRepositoryCtor(deps as never);

  const bin = (id: string): Binary => binUuidFn(id);

  const cleanupOrg = async (orgId: string): Promise<void> => {
    const orgBin = bin(orgId);
    await deps.withBypass(async (ctx) => {
      const session = (ctx as { session: unknown }).session as never;
      const configIds = await db
        .collection('published_configs')
        .distinct('id', { org_id: orgBin }, { session });
      await db.collection('config_notifications').deleteMany(
        { config_id: { $in: configIds } },
        { session },
      );
      await db.collection('published_configs').deleteMany({ org_id: orgBin }, { session });
      await db.collection('config_drafts').deleteMany({ org_id: orgBin }, { session });
    });
  };

  const lane: Lane = {
    name: 'mongo',
    published: () => publishedRepo,
    drafts: () => draftRepo,
    notifications: () => notifRepo,
    service: (satellites) => buildService(publishedRepo, draftRepo, notifRepo, satellites),
    cleanupOrg,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
      await mongoClient?.close().catch(() => undefined);
      await mongoReplSet?.stop().catch(() => undefined);
    },
  };
  return lane;
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

const lanes: Lane[] = [];

beforeAll(async () => {
  const pg = await buildPgLane();
  if (pg) lanes.push(pg);
  const mongo = await buildMongoLane();
  if (mongo) lanes.push(mongo);
  if (lanes.length === 0) {
    console.warn('[parity] no lane available — all scenarios skipped');
  }
}, 180_000);

afterAll(async () => {
  for (const lane of lanes) {
    await lane.teardown().catch(() => undefined);
  }
});

async function eachLane<T>(fn: (lane: Lane) => Promise<T>): Promise<void> {
  for (const lane of lanes) {
    await fn(lane);
  }
}

describe('config-publish repository parity', () => {
  it('publish round-trip + version increment, latest/version/history/since/bootstrap', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      const v1 = await publishVersion(lane, orgId, payloadA());
      expect(v1.version).toBe(1);
      expect(v1.scope).toBe(SCOPE);
      expect(v1.product).toBeNull();
      expect(v1.rollbackOf).toBeNull();

      const v2 = await publishVersion(lane, orgId, payloadB());
      expect(v2.version).toBe(2);
      expect(v2.payloadHash).not.toBe(v1.payloadHash);

      const svc = makeService(lane);
      const latest = await svc.latest(orgId, SCOPE, null);
      expect(latest?.id).toBe(v2.id);
      expect(latest?.version).toBe(2);

      const first = await svc.version(orgId, SCOPE, null, 1);
      expect(first?.id).toBe(v1.id);
      expect(first?.payloadHash).toBe(v1.payloadHash);

      expect(await svc.version(orgId, SCOPE, null, 99)).toBeNull();

      const history = await svc.history(orgId, SCOPE, null, 25, 0);
      expect(history.total).toBe(2);
      expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
      const page = await svc.history(orgId, SCOPE, null, 1, 1);
      expect(page.versions.map((v) => v.version)).toEqual([1]);

      const pull = await svc.since(orgId, SCOPE, null, 0, 100);
      expect(pull.configs.map((c) => c.version)).toEqual([1, 2]);
      expect(pull.nextSince).toBe(2);
      expect(pull.hasMore).toBe(false);
      const pull1 = await svc.since(orgId, SCOPE, null, 1, 100);
      expect(pull1.configs.map((c) => c.version)).toEqual([2]);
      const capped = await svc.since(orgId, SCOPE, null, 0, 1);
      expect(capped.configs.map((c) => c.version)).toEqual([1]);
      expect(capped.hasMore).toBe(true);
      expect(capped.nextSince).toBe(1);

      const boot = await svc.bootstrap(orgId);
      expect(boot.configs).toHaveLength(1);
      expect(boot.configs[0].version).toBe(2);
      expect(boot.cursors[SCOPE]).toBe(2);
    });
  });

  it('byte-identical republish → conflict; changed payload publishes', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      await publishVersion(lane, orgId, payloadA());
      try {
        await publishVersion(lane, orgId, payloadA());
        expect.unreachable('byte-identical republish must conflict');
      } catch (err) {
        expect(codeOf(err)).toBe('conflict');
      }
      // A changed payload is a real new version, not a conflict.
      const v2 = await publishVersion(lane, orgId, payloadB());
      expect(v2.version).toBe(2);
    });
  });

  it('concurrent publishes on one key serialize: versions exactly 1..N', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => publishVersion(lane, orgId, payloadN(i))),
      );
      const versions = results.map((r) => r.version).sort((a, b) => a - b);
      expect(versions).toEqual(Array.from({ length: N }, (_, i) => i + 1));
      // No two versions share a payload hash (no lost writes, no duplicates).
      const hashes = new Set(results.map((r) => r.payloadHash));
      expect(hashes.size).toBe(N);
      const history = await makeService(lane).history(orgId, SCOPE, null, 100, 0);
      expect(history.total).toBe(N);
    });
  });

  it('draft save/list/delete; invalid drafts persist but cannot publish', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      const svc = makeService(lane);

      const saved = await svc.saveDraft({
        orgId,
        scope: SCOPE,
        product: null,
        payload: payloadA(),
        updatedBy: 'parity-operator',
      });
      expect(saved.validationStatus).toBe('valid');
      expect((await svc.getDraft(orgId, SCOPE, null))?.id).toBe(saved.id);

      // Re-save upserts in place: same id, new payload.
      const resaved = await svc.saveDraft({
        orgId,
        scope: SCOPE,
        product: null,
        payload: payloadB(),
        updatedBy: 'parity-operator',
      });
      expect(resaved.id).toBe(saved.id);
      expect(resaved.payloadHash).not.toBe(saved.payloadHash);

      const drafts = await svc.listDrafts(orgId);
      expect(drafts.map((d) => d.id)).toContain(saved.id);

      // Invalid drafts persist WITH their report...
      const bad = await svc.saveDraft({
        orgId,
        scope: SCOPE,
        product: 'some_product',
        payload: invalidPayload(),
        updatedBy: 'parity-operator',
      });
      expect(bad.validationStatus).toBe('invalid');
      expect(bad.validationIssues).not.toBeNull();

      // ...but cannot publish.
      try {
        await svc.publishDraft({ orgId, scope: SCOPE, product: 'some_product', publishedBy: 'parity-operator' });
        expect.unreachable('invalid draft must not publish');
      } catch (err) {
        expect(codeOf(err)).toBe('validation');
      }

      // publishDraft on the valid draft publishes and drops the draft.
      const published = await svc.publishDraft({
        orgId,
        scope: SCOPE,
        product: null,
        publishedBy: 'parity-operator',
      });
      expect(published.version).toBe(1);
      expect(await svc.getDraft(orgId, SCOPE, null)).toBeNull();

      await svc.deleteDraft(orgId, SCOPE, 'some_product', 'parity-operator');
      expect(await svc.getDraft(orgId, SCOPE, 'some_product')).toBeNull();
      // Deleting a missing draft is a no-op, never an error.
      await svc.deleteDraft(orgId, SCOPE, 'some_product', 'parity-operator');
    });
  });

  it('rollback creates a new version; already-live rollback → conflict', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      const svc = makeService(lane);
      const v1 = await publishVersion(lane, orgId, payloadA());
      await publishVersion(lane, orgId, payloadB());

      const v3 = await svc.rollback({
        orgId,
        scope: SCOPE,
        product: null,
        toVersion: 1,
        publishedBy: 'parity-operator',
      });
      expect(v3.version).toBe(3);
      expect(v3.rollbackOf).toBe(1);
      expect(v3.payloadHash).toBe(v1.payloadHash);

      // v1's content is live again — rolling back to it is a no-op conflict.
      try {
        await svc.rollback({ orgId, scope: SCOPE, product: null, toVersion: 1, publishedBy: 'parity-operator' });
        expect.unreachable('rollback to live content must conflict');
      } catch (err) {
        expect(codeOf(err)).toBe('conflict');
      }

      // Unknown version → not_found.
      try {
        await svc.rollback({ orgId, scope: SCOPE, product: null, toVersion: 99, publishedBy: 'parity-operator' });
        expect.unreachable('rollback to missing version must 404');
      } catch (err) {
        expect(codeOf(err)).toBe('not_found');
      }
    });
  });

  it('notification ledger: fanout → pending → ack; duplicate fanout is a no-op', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      const satellites = [{ key: 'sat-1', status: 'active', products: ['anything'] }];
      const published = await publishVersion(lane, orgId, payloadA(), satellites);

      const pending = await lane.notifications().pendingFor('sat-1', 50);
      expect(pending.map((p) => p.configId)).toEqual([published.id]);

      // Duplicate fanout never duplicates the row.
      await lane.notifications().insertFanout(published.id, ['sat-1']);
      expect((await lane.notifications().pendingFor('sat-1', 50)).length).toBe(1);

      const status = await makeService(lane, satellites).deliveryStatus(orgId, SCOPE, null);
      expect(status.config.id).toBe(published.id);
      expect(status.targets).toHaveLength(1);
      expect(status.targets[0].satelliteKey).toBe('sat-1');
      expect(status.targets[0].ackedAt).toBeNull();

      await lane.notifications().ack(published.id, 'sat-1');
      expect(await lane.notifications().pendingFor('sat-1', 50)).toEqual([]);
      const acked = await makeService(lane, satellites).deliveryStatus(orgId, SCOPE, null);
      expect(acked.targets[0].ackedAt).not.toBeNull();

      // renotify re-opens the row for the satellite.
      await makeService(lane, satellites).renotify(published.id, 'parity-operator');
      expect((await lane.notifications().pendingFor('sat-1', 50)).length).toBe(1);
    });
  });

  it('cross-org isolation: versions, drafts, and history are invisible across orgs', async () => {
    await eachLane(async (lane) => {
      const orgA = trackOrg(randomUUID());
      const orgB = trackOrg(randomUUID());
      await publishVersion(lane, orgA, payloadA());
      await makeService(lane).saveDraft({
        orgId: orgA,
        scope: SCOPE,
        product: null,
        payload: payloadA(),
        updatedBy: 'parity-operator',
      });

      const svc = makeService(lane);
      expect(await svc.latest(orgB, SCOPE, null)).toBeNull();
      expect(await svc.version(orgB, SCOPE, null, 1)).toBeNull();
      expect((await svc.history(orgB, SCOPE, null, 25, 0)).total).toBe(0);
      expect(await svc.getDraft(orgB, SCOPE, null)).toBeNull();
      expect(await svc.listDrafts(orgB)).toEqual([]);
      expect((await svc.bootstrap(orgB)).configs).toEqual([]);
      expect((await svc.since(orgB, SCOPE, null, 0, 100)).configs).toEqual([]);
    });
  });

  it('diff compares two versions and latest-vs-draft', async () => {
    await eachLane(async (lane) => {
      const orgId = trackOrg(randomUUID());
      const svc = makeService(lane);
      await publishVersion(lane, orgId, payloadA());
      await publishVersion(lane, orgId, payloadB());
      await svc.saveDraft({
        orgId,
        scope: SCOPE,
        product: null,
        payload: payloadA(),
        updatedBy: 'parity-operator',
      });

      const d = await svc.diff(orgId, SCOPE, null, 1, 2);
      expect(d.a).toBe('1');
      expect(d.b).toBe('2');
      expect(d.entries.length).toBeGreaterThan(0);

      const same = await svc.diff(orgId, SCOPE, null, 1, 1);
      expect(same.entries).toEqual([]);

      const vsDraft = await svc.diff(orgId, SCOPE, null, 2, 'draft');
      expect(vsDraft.b).toBe('draft');
      expect(vsDraft.entries.length).toBeGreaterThan(0);
    });
  });
});
