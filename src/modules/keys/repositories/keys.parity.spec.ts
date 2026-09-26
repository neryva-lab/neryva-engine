/**
 * Keys repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through `IApiKeyRepository` and
 * `IStudioProjectKeyRepository`.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. Key create/list/get round-trip + cross-org isolation: org B sees none
 *     of org A's keys (list empty, get → null, revoke/update/rotate →
 *     `not_found`).
 *  2. Duplicate key_hash insert → `conflict` on both lanes (pg 23505
 *     `uq_api_keys_key_hash` / mongo 11000).
 *  3. Auth lookup by key_hash (bypass): known hash resolves the row (org
 *     comes from the row's tenant_id); unknown hash → null; revoked key →
 *     the row with `revoked: true` (the revoked/expired policy lives in the
 *     service, the port returns the row).
 *  4. Rotate: the new hash resolves, the old hash no longer does,
 *     `usage_count` resets to 0, name/prefix policy preserved; the returned
 *     pre-rotation row carries the old name.
 *  5. Revoke is a soft revoke: the row remains readable with
 *     `revoked: true`; update/rotate on a revoked or missing key →
 *     `not_found`.
 *  6. Project-key binding: bind at issue → round-trip read; a duplicate
 *     bind is a silent no-op (still exactly one binding row); cross-org
 *     binding read → null.
 *  7. Expiring-key scan (bypass, cross-org): only non-revoked keys with a
 *     known expiry at or before the horizon appear — keys with no expiry
 *     and revoked keys are excluded on both lanes.
 *  8. Key event trail: `key.*` audit events for the key come back newest
 *     first (cap 50); non-`key.` actions are excluded.
 *
 * Cross-provider determinism: the same logical flow on both lanes yields
 * the same error codes. Row ids are randomUUID on both lanes but are NOT
 * byte-identical across lanes (generated independently per write);
 * timestamps are ISO-8601 strings on both lanes but wall-clock values
 * differ — neither is asserted across lanes.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). Tables are
 * provisioned idempotently from the drizzle schema shapes (`api_keys` is
 * the Python-owned DDL mirror from drizzle/0059_legacy_standalone.sql —
 * it carries NO RLS in production, so the fixture has none either; the
 * `studio_project_keys` table mirrors drizzle/0006). No FK constraints:
 * the repositories never rely on FK cascades in the tested paths, and
 * skipping them keeps provisioning order-independent.
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withOrg`/`withBypass` with the exact `withSession` semantics:
 * one ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the conversations parity
 * spec — so this file never depends on the import-time `env.ts` parse.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Binary, Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { ApiError } from '../../../common/http/api-error';
import type {
  ApiKeyCreateInput,
  IApiKeyRepository,
  IStudioProjectKeyRepository,
} from './keys.repository';

// ---------------------------------------------------------------------------
// lane abstraction (fixture + white-box reads, per provider)
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  keys(): IApiKeyRepository;
  projectKeys(): IStudioProjectKeyRepository;
  cleanupOrg(orgId: string): Promise<void>;
  seedAuditEvent(keyId: string, action: string, createdAt: string): Promise<void>;
  bindingCount(orgId: string, apiKeyId: string): Promise<number>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see buildPgLane).
// DbService is imported as a TYPE only — the runtime import happens
// dynamically in buildPgLane so env.ts parses after DATABASE_URL is set.
let PgApiKeyRepositoryCtor: new (db: never) => IApiKeyRepository;
let PgStudioProjectKeyRepositoryCtor: new (db: never) => IStudioProjectKeyRepository;
// MongoDbService-shaped harness (root + withOrg/withBypass with the exact
// MongoDbService.withSession semantics: one ClientSession, one majority
// transaction via runInTransaction, session closed in finally). Used instead
// of MongoDbService itself so this spec never depends on the import-time
// `env.ts` parse — same precedent as the conversations parity spec.
interface MongoLaneDeps {
  root: Db;
  withOrg<T>(orgId: string, fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
  withBypass<T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
}
let MongoApiKeyRepositoryCtor: new (m: never) => IApiKeyRepository;
let MongoStudioProjectKeyRepositoryCtor: new (m: never) => IStudioProjectKeyRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

// ---------------------------------------------------------------------------
// key material helpers
// ---------------------------------------------------------------------------

function newKeyMaterial(): { keyHash: string; prefix: string } {
  const raw = `nrv_live_${randomBytes(32).toString('base64url')}`;
  return {
    keyHash: createHash('sha256').update(raw).digest('hex'),
    prefix: `nrv_live_${raw.slice('nrv_live_'.length, 'nrv_live_'.length + 8)}`,
  };
}

function createInput(orgId: string, over?: Partial<ApiKeyCreateInput>): ApiKeyCreateInput {
  const km = newKeyMaterial();
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    orgId,
    name: `parity-key-${randomUUID().slice(0, 8)}`,
    keyHash: km.keyHash,
    prefix: km.prefix,
    role: 'operator',
    scopes: ['keys:read'],
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the drizzle schema sources. Idempotent
// (IF NOT EXISTS). `api_keys`/`audit_events` are the Python-owned legacy
// mirrors (drizzle/0059_legacy_standalone.sql) — no RLS, faithful to prod.
// ---------------------------------------------------------------------------

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "api_keys" (
     "id" varchar(36) PRIMARY KEY,
     "name" varchar(128) NOT NULL,
     "key_hash" varchar(64) NOT NULL,
     "prefix" varchar(32) NOT NULL,
     "role" varchar(32) NOT NULL,
     "tenant_id" varchar(36),
     "scopes" jsonb NOT NULL,
     "expires_at" timestamptz,
     "revoked" boolean NOT NULL,
     "last_used_at" timestamptz,
     "usage_count" integer NOT NULL,
     "mfa_secret" varchar(255),
     "mfa_enabled" boolean NOT NULL,
     "created_at" timestamptz NOT NULL,
     "updated_at" timestamptz NOT NULL,
     CONSTRAINT "uq_api_keys_key_hash" UNIQUE ("key_hash")
   )`,
  `CREATE TABLE IF NOT EXISTS "studio_project_keys" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "org_id" varchar(36) NOT NULL,
     "api_key_id" varchar(36) NOT NULL,
     "project_id" uuid NOT NULL,
     "bound_by" uuid NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_studio_project_keys_key" UNIQUE ("org_id", "api_key_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "audit_events" (
     "id" varchar(36) PRIMARY KEY,
     "tenant_id" varchar(36),
     "actor_type" varchar(16) NOT NULL,
     "actor_id" varchar(64),
     "action" varchar(64) NOT NULL,
     "resource_type" varchar(64) NOT NULL,
     "resource_id" varchar(64),
     "details" jsonb NOT NULL,
     "prev_hash" varchar(64),
     "event_hash" varchar(64),
     "created_at" timestamptz NOT NULL
   )`,
];

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
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

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
    return null;
  }
  // env.ts parses at import time: the URL must be in place BEFORE the first
  // dynamic import below touches src/common/config/env.ts.
  process.env.DATABASE_URL ??= DATABASE_URL;
  const { DbService } = await import('../../../common/infra/db/db.service');
  const apiKeyMod = await import('./pg-api-key.repository');
  const bindingMod = await import('./pg-studio-project-key.repository');
  PgApiKeyRepositoryCtor = apiKeyMod.PgApiKeyRepository;
  PgStudioProjectKeyRepositoryCtor = bindingMod.PgStudioProjectKeyRepository;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const keysRepo = new PgApiKeyRepositoryCtor(db as never);
  const bindingsRepo = new PgStudioProjectKeyRepositoryCtor(db as never);

  const cleanupOrg = async (orgId: string): Promise<void> => {
    await (db as never as { withBypass<T>(f: (tx: never) => Promise<T>): Promise<T> }).withBypass(
      async (tx) => {
        const d = tx as unknown as { execute(q: unknown): Promise<unknown> };
        await d.execute(sql`delete from studio_project_keys where org_id = ${orgId}`);
        await d.execute(sql`delete from api_keys where tenant_id = ${orgId}`);
      },
    );
  };

  const seedAuditEvent = async (keyId: string, action: string, createdAt: string): Promise<void> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await pool.query(
        `insert into audit_events
           (id, actor_type, actor_id, action, resource_type, resource_id, details, created_at)
         values ($1, 'account', 'parity-actor', $2, 'api_key', $3, '{}', $4)`,
        [randomUUID(), action, keyId, createdAt],
      );
    } finally {
      await pool.end();
    }
  };

  const bindingCount = async (orgId: string, apiKeyId: string): Promise<number> => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const r = await pool.query(
        `select count(*)::int as n from studio_project_keys where org_id = $1 and api_key_id = $2`,
        [orgId, apiKeyId],
      );
      return (r.rows[0] as { n: number }).n;
    } finally {
      await pool.end();
    }
  };

  return {
    name: 'pg',
    keys: () => keysRepo,
    projectKeys: () => bindingsRepo,
    cleanupOrg,
    seedAuditEvent,
    bindingCount,
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
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-keys-parity-${process.pid}`;
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

  const apiKeyMod = await import('./mongo-api-key.repository');
  const bindingMod = await import('./mongo-studio-project-key.repository');
  const docsMod = await import('./mongo-documents');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoApiKeyRepositoryCtor = apiKeyMod.MongoApiKeyRepository;
  MongoStudioProjectKeyRepositoryCtor = bindingMod.MongoStudioProjectKeyRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_keys_parity');
  await runMongoMigrationsFn(db);
  // Defensive unique indexes the key writes rely on (also ensured inside
  // createKey/bindKeyToProject; harmless to ensure up front).
  await docsMod.ensureKeysIndexes(db);

  // Exact MongoDbService.withSession semantics (private there; replicated
  // here per the conversations parity precedent so the repositories run
  // their real code paths).
  const withSession = async <T>(
    orgId: string | null,
    fn: (ctx: { session: never; orgId: string | null }) => Promise<T>,
  ): Promise<T> => {
    const session = client.startSession();
    try {
      return await runInTransaction(session, () => fn({ session: session as never, orgId }));
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

  const keysRepo = new MongoApiKeyRepositoryCtor(deps as never);
  const bindingsRepo = new MongoStudioProjectKeyRepositoryCtor(deps as never);

  const bin = (id: string): Binary => docsMod.binUuid(id);

  const cleanupOrg = async (orgId: string): Promise<void> => {
    const orgBin = bin(orgId);
    await deps.withBypass(async (ctx) => {
      const session = (ctx as { session: unknown }).session as never;
      await db.collection('studio_project_keys').deleteMany({ org_id: orgBin }, { session });
      await db.collection('api_keys').deleteMany({ tenant_id: orgBin }, { session });
      await db.collection('audit_events').deleteMany({}, { session });
    });
  };

  const seedAuditEvent = async (keyId: string, action: string, createdAt: string): Promise<void> => {
    await db.collection('audit_events').insertOne({
      id: randomUUID(),
      actor_type: 'account',
      actor_id: 'parity-actor',
      action,
      resource_type: 'api_key',
      resource_id: keyId,
      details: {},
      created_at: createdAt,
    });
  };

  const bindingCount = async (orgId: string, apiKeyId: string): Promise<number> => {
    return db.collection('studio_project_keys').countDocuments({
      org_id: bin(orgId),
      api_key_id: bin(apiKeyId),
    });
  };

  return {
    name: 'mongo',
    keys: () => keysRepo,
    projectKeys: () => bindingsRepo,
    cleanupOrg,
    seedAuditEvent,
    bindingCount,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
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
    console.warn('[parity] no lane available — all scenarios skipped');
  }
}, 120_000);

afterAll(async () => {
  await pgLane?.teardown().catch(() => undefined);
  await mongoLane?.teardown().catch(() => undefined);
  await mongoClient?.close().catch(() => undefined);
  await mongoReplSet?.stop().catch(() => undefined);
});

function lanes(): Lane[] {
  return [pgLane, mongoLane].filter((l): l is Lane => l !== null);
}

describe.each([['pg'], ['mongo']])('keys parity (%s lane)', (laneName) => {
  const lane = (): Lane | null => (laneName === 'pg' ? pgLane : mongoLane);

  it('create/list/get round-trip + cross-org isolation', async () => {
    const l = lane();
    if (!l) return;
    const orgA = trackOrg(randomUUID());
    const orgB = trackOrg(randomUUID());

    const created = await l.keys().createKey(createInput(orgA));
    expect(created.id).toBeTruthy();

    const listed = await l.keys().listKeys(orgA);
    expect(listed.map((k) => k.id)).toContain(created.id);
    expect(listed[0].revoked).toBe(false);
    expect(listed[0].usage_count).toBe(0);

    const got = await l.keys().getKey(orgA, created.id);
    expect(got?.id).toBe(created.id);
    expect(got?.tenant_id).toBe(orgA);

    // Org B is fully isolated from org A's key.
    expect(await l.keys().listKeys(orgB)).toHaveLength(0);
    expect(await l.keys().getKey(orgB, created.id)).toBeNull();
    expect(codeOf(await (l.keys().revokeKey(orgB, created.id)).catch((e: unknown) => e))).toBe('not_found');
    expect(codeOf(await (
      l.keys().updateKey(orgB, created.id, { name: 'x' })
    ).catch((e: unknown) => e))).toBe('not_found');
    expect(codeOf(await (
      l.keys().rotateKey(orgB, created.id, newKeyMaterial())
    ).catch((e: unknown) => e))).toBe('not_found');
  });

  it('duplicate key_hash insert → conflict', async () => {
    const l = lane();
    if (!l) return;
    const org = trackOrg(randomUUID());
    const km = newKeyMaterial();
    await l.keys().createKey(createInput(org, { keyHash: km.keyHash, prefix: km.prefix }));
    // Same hash, fresh id — the unique key_hash claim is what conflicts.
    const err = await l
      .keys()
      .createKey(createInput(org, { keyHash: km.keyHash, prefix: km.prefix }))
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('conflict');
  });

  it('auth lookup by key_hash (bypass)', async () => {
    const l = lane();
    if (!l) return;
    const org = trackOrg(randomUUID());
    const km = newKeyMaterial();
    const created = await l.keys().createKey(createInput(org, { keyHash: km.keyHash, prefix: km.prefix }));

    const row = await l.keys().findByKeyHash(km.keyHash);
    expect(row?.id).toBe(created.id);
    expect(row?.tenant_id).toBe(org);
    expect(row?.revoked).toBe(false);

    // Unknown hash is a null row, not an error (an authentication decision).
    expect(await l.keys().findByKeyHash('0'.repeat(64))).toBeNull();

    // A revoked key still resolves — the revoked policy lives in the
    // service; the port returns the row.
    await l.keys().revokeKey(org, created.id);
    const revoked = await l.keys().findByKeyHash(km.keyHash);
    expect(revoked?.revoked).toBe(true);
  });

  it('rotate swaps the secret, resets usage, preserves identity', async () => {
    const l = lane();
    if (!l) return;
    const org = trackOrg(randomUUID());
    const before = newKeyMaterial();
    const created = await l.keys().createKey(
      createInput(org, { name: 'rotate-me', keyHash: before.keyHash, prefix: before.prefix }),
    );
    const after = newKeyMaterial();

    const preRotation = await l.keys().rotateKey(org, created.id, {
      keyHash: after.keyHash,
      prefix: after.prefix,
    });
    expect(preRotation.name).toBe('rotate-me');
    expect(preRotation.id).toBe(created.id);

    // New hash resolves; old hash is dead.
    const rotated = await l.keys().findByKeyHash(after.keyHash);
    expect(rotated?.id).toBe(created.id);
    expect(rotated?.prefix).toBe(after.prefix);
    expect(rotated?.usage_count).toBe(0);
    expect(await l.keys().findByKeyHash(before.keyHash)).toBeNull();

    // Rotating a missing or revoked key is not_found.
    expect(codeOf(await (
      l.keys().rotateKey(org, randomUUID(), newKeyMaterial())
    ).catch((e: unknown) => e))).toBe('not_found');
    await l.keys().revokeKey(org, created.id);
    expect(codeOf(await (
      l.keys().rotateKey(org, created.id, newKeyMaterial())
    ).catch((e: unknown) => e))).toBe('not_found');
  });

  it('revoke is a soft revoke; update on revoked/missing → not_found', async () => {
    const l = lane();
    if (!l) return;
    const org = trackOrg(randomUUID());
    const created = await l.keys().createKey(createInput(org));

    await l.keys().updateKey(org, created.id, { name: 'renamed', scopes: ['keys:read', 'runs:write'] });
    const updated = await l.keys().getKey(org, created.id);
    expect(updated?.name).toBe('renamed');
    expect(updated?.scopes).toEqual(['keys:read', 'runs:write']);

    await l.keys().revokeKey(org, created.id);
    const revoked = await l.keys().getKey(org, created.id);
    expect(revoked?.revoked).toBe(true);

    expect(codeOf(await (
      l.keys().updateKey(org, created.id, { name: 'nope' })
    ).catch((e: unknown) => e))).toBe('not_found');
    expect(codeOf(await (l.keys().revokeKey(org, randomUUID())).catch((e: unknown) => e))).toBe('not_found');
  });

  it('project-key binding round-trip; duplicate bind is a silent no-op', async () => {
    const l = lane();
    if (!l) return;
    const orgA = trackOrg(randomUUID());
    const orgB = trackOrg(randomUUID());
    const projectId = randomUUID();
    const boundBy = randomUUID();

    const created = await l.keys().createKey(createInput(orgA));
    await l.projectKeys().bindKeyToProject({
      orgId: orgA,
      apiKeyId: created.id,
      projectId,
      boundBy,
    });
    const binding = await l.projectKeys().getBindingByKeyId(orgA, created.id);
    expect(binding?.projectId).toBe(projectId);
    expect(binding?.apiKeyId).toBe(created.id);
    expect(binding?.orgId).toBe(orgA);

    // Duplicate bind: no error, still exactly one binding row.
    await l.projectKeys().bindKeyToProject({
      orgId: orgA,
      apiKeyId: created.id,
      projectId,
      boundBy,
    });
    expect(await l.bindingCount(orgA, created.id)).toBe(1);

    // Cross-org binding read is null; unbound key is null.
    expect(await l.projectKeys().getBindingByKeyId(orgB, created.id)).toBeNull();
    const unbound = await l.keys().createKey(createInput(orgA));
    expect(await l.projectKeys().getBindingByKeyId(orgA, unbound.id)).toBeNull();
  });

  it('expiring-key scan: only non-revoked keys with a known expiry ≤ horizon', async () => {
    const l = lane();
    if (!l) return;
    const org = trackOrg(randomUUID());
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const horizon = new Date(Date.now() + 14 * 86_400_000).toISOString();

    const expiring = await l.keys().createKey(createInput(org, { expiresAt: soon }));
    await l.keys().createKey(createInput(org, { expiresAt: later }));
    await l.keys().createKey(createInput(org, { expiresAt: null }));
    const revokedSoon = await l.keys().createKey(createInput(org, { expiresAt: soon }));
    await l.keys().revokeKey(org, revokedSoon.id);

    const rows = await l.keys().scanExpiringKeys(horizon);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(expiring.id);
    expect(ids).not.toContain(revokedSoon.id);
    expect(rows).toHaveLength(1);
    const hit = rows.find((r) => r.id === expiring.id);
    expect(hit?.tenantId).toBe(org);
    expect(hit?.expiresAt).toBeTruthy();

    // A horizon before every expiry finds nothing.
    const none = await l.keys().scanExpiringKeys(new Date(Date.now() + 3_600_000).toISOString());
    expect(none).toHaveLength(0);
  });

  it('key event trail: key.* newest-first, non-key actions excluded', async () => {
    const l = lane();
    if (!l) return;
    const org = trackOrg(randomUUID());
    const created = await l.keys().createKey(createInput(org));

    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 30_000).toISOString();
    await l.seedAuditEvent(created.id, 'key.created', t0);
    await l.seedAuditEvent(created.id, 'assistant.published', t1);
    await l.seedAuditEvent(created.id, 'key.rotated', new Date().toISOString());

    const events = await l.keys().listKeyEvents(created.id);
    expect(events.map((e) => e.action)).toEqual(['key.rotated', 'key.created']);
    expect(events[0].created_at).toBeTruthy();
  });
});

describe('keys lanes availability', () => {
  it('at least one lane ran (the other skips with a warning)', () => {
    expect(lanes().length).toBeGreaterThan(0);
  });
});
