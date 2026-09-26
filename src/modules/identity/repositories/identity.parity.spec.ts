/**
 * Identity repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through the repository interfaces
 * (`IEmailCodeRepository`, `IRefreshTokenRepository`,
 * `ISessionRepository`, `IAccountRepository`).
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  a. email-code concurrent verify-and-burn: issue → 8 parallel
 *     `consume` on one code → exactly 1 wins (true), 7 lose (false);
 *     the code is then invisible to `findLive`.
 *  b. email-code issue discipline: a fresh issue voids previous
 *     unconsumed codes (they vanish from `findLive`); failed attempts
 *     increment the attempt counter on the account's live rows.
 *  c. refresh rotation: upsert A → rotate to B (A gets `consumedAt`) →
 *     presenting A again → `reused`, the whole family is revoked
 *     (`revokedAt` + `retiredAt` on every member), `firstDetection`
 *     true; a repeat replay → `reused` with `firstDetection` false.
 *  d. refresh rotation concurrency: 8 parallel consumes of one live
 *     token → exactly 1 `consumed`, 7 `reused` (the losers tripped the
 *     reuse wire); the family ends revoked exactly once.
 *  e. refresh grant cascade: `revokeByGrantId` retires every token of
 *     the grant and leaves other grants untouched.
 *  f. session revocation: upsert → `listActive` shows it → `revokeOne`
 *     (account-scoped CAS) marks it revoked → `listActive` hides it;
 *     revoking another account's session → null (404 mapping).
 *  g. session revocation fan-out: `revokeByJtis` retires the session's
 *     refresh tokens (a revoked session cannot rotate back to life).
 *  h. session uid revocation: `revokeBySessionUid` (the reuse-tripwire
 *     path) marks the row revoked; `findSessionGuard` still resolves
 *     the account row for deny-list fan-out.
 *  i. kill-switch: `revokeAllSessions` stamps `sessions_revoked_at` AND
 *     marks the account's session rows revoked — `listActive` hides them,
 *     other accounts untouched.
 *
 * pg lane: real `DbService` against the dedicated `neryva_parity` database
 * (created on demand — NEVER the live `neryva` DB). Tables are provisioned
 * idempotently with the real column shapes from
 * `src/modules/identity/schema.ts` (accounts, email_login_codes,
 * oauth_sessions, oauth_refresh_tokens). No FK constraints in the fixture:
 * the repositories never rely on FK cascades in the tested paths, and
 * skipping them keeps provisioning order-independent (same precedent as
 * the P2 idempotency parity spec).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withOrg`/`withBypass` with the exact `withSession` semantics:
 * one ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the P2 idempotency parity
 * spec — so this file never depends on the import-time `env.ts` parse for
 * the mongo lane.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import type { IEmailCodeRepository } from './email-code.repository';
import type { IRefreshTokenRepository, RefreshConsumeOutcome } from './refresh-token.repository';
import type { ISessionRepository } from './session.repository';
import type { IAccountRepository } from './account.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  emailCodes(): IEmailCodeRepository;
  refreshTokens(): IRefreshTokenRepository;
  sessions(): ISessionRepository;
  accounts(): IAccountRepository;
  teardown(): Promise<void>;
}

let PgEmailCodeRepositoryCtor: new (db: never) => IEmailCodeRepository;
let PgRefreshTokenRepositoryCtor: new (db: never) => IRefreshTokenRepository;
let PgSessionRepositoryCtor: new (db: never) => ISessionRepository;
let PgAccountRepositoryCtor: new (db: never) => IAccountRepository;

interface MongoLaneDeps {
  root: Db;
  withOrg<T>(orgId: string, fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
  withBypass<T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
}
let MongoEmailCodeRepositoryCtor: new (m: never) => IEmailCodeRepository;
let MongoRefreshTokenRepositoryCtor: new (m: never) => IRefreshTokenRepository;
let MongoSessionRepositoryCtor: new (m: never) => ISessionRepository;
let MongoAccountRepositoryCtor: new (m: never) => IAccountRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const nowIso = (): string => new Date().toISOString();
const futureIso = (ms: number): string => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------------------
// pg DDL (real column shapes from src/modules/identity/schema.ts)
// ---------------------------------------------------------------------------

const PG_TABLES = [
  `CREATE TABLE IF NOT EXISTS "accounts" (
     "id" uuid PRIMARY KEY,
     "email" citext NOT NULL,
     "email_verified_at" timestamptz,
     "display_name" varchar(256),
     "status" varchar(32) NOT NULL DEFAULT 'active',
     "mfa_level" varchar(16) NOT NULL DEFAULT 'none',
     "created_via" varchar(32) NOT NULL DEFAULT 'email_code',
     "sessions_revoked_at" timestamptz,
     "deleted_at" timestamptz,
     "last_login_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_accounts_email" ON "accounts" ("email")`,
  `CREATE TABLE IF NOT EXISTS "email_login_codes" (
     "id" uuid PRIMARY KEY,
     "account_id" uuid NOT NULL,
     "code_hash" varchar(64) NOT NULL,
     "request_ip" varchar(64),
     "expires_at" timestamptz NOT NULL,
     "attempts" integer NOT NULL DEFAULT 0,
     "consumed_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS "ix_email_codes_account" ON "email_login_codes" ("account_id")`,
  `CREATE TABLE IF NOT EXISTS "oauth_sessions" (
     "sid" varchar(128) PRIMARY KEY,
     "account_id" uuid NOT NULL,
     "client_id" varchar(64) NOT NULL,
     "family_id" uuid NOT NULL,
     "session_uid" varchar(128),
     "device" jsonb NOT NULL DEFAULT '{}'::jsonb,
     "ip_country" varchar(8),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "last_seen_at" timestamptz,
     "revoked_at" timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS "ix_oauth_sessions_account" ON "oauth_sessions" ("account_id")`,
  `CREATE INDEX IF NOT EXISTS "ix_oauth_sessions_uid" ON "oauth_sessions" ("session_uid")`,
  `CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
     "jti" varchar(128) PRIMARY KEY,
     "family_id" uuid NOT NULL,
     "session_id" varchar(128),
     "token_hash" varchar(64) NOT NULL,
     "grant_id" varchar(128),
     "expires_at" timestamptz NOT NULL,
     "rotated_from" varchar(128),
     "consumed_at" timestamptz,
     "retired_at" timestamptz,
     "revoked_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS "ix_refresh_tokens_family" ON "oauth_refresh_tokens" ("family_id")`,
];

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  // The parity database is created bare (no migrations run against it);
  // identity tables need citext for the case-insensitive email column.
  await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS citext`));
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  // drizzle schemas declare account/code ids as .defaultRandom(): the
  // repositories insert `default` for ids and rely on the DB default
  // (gen_random_uuid()). Idempotent — replays safely over the CREATEs.
  for (const t of ['accounts', 'email_login_codes']) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`));
  }
}

// ---------------------------------------------------------------------------
// lane construction
// ---------------------------------------------------------------------------

// The parity pg lane is UNCONDITIONALLY pinned to the dedicated parity
// database. It must never honor TEST_DATABASE_URL or inherit a caller's
// DATABASE_URL (which may point at the live `neryva` database — the parity
// spec is forbidden from touching live data).
const PARITY_PG_URL = 'postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva_parity';

async function resolvePgUrl(): Promise<string> {
  // The admin connection targets /postgres on the same host/role solely to
  // create `neryva_parity` when it is absent; the lane itself always connects
  // to the pinned parity URL above.
  const adminUrl = new URL(PARITY_PG_URL);
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const { rowCount } = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = 'neryva_parity'`);
    if (rowCount === 0) await adminPool.query(`CREATE DATABASE "neryva_parity"`);
  } finally {
    await adminPool.end();
  }
  return PARITY_PG_URL;
}

let pgLane: Lane | null = null;
let mongoLane: Lane | null = null;

async function buildPgLane(): Promise<Lane | null> {
  let pgUrl: string;
  try {
    pgUrl = await resolvePgUrl();
  } catch (err) {
    console.warn('[parity] pg lane unavailable — skipped:', (err as Error).message);
    return null;
  }
  const reachable = new Pool({ connectionString: pgUrl, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await reachable.query('select 1');
  } catch (err) {
    console.warn('[parity] pg parity database unreachable — pg lane skipped:', (err as Error).message);
    await reachable.end();
    return null;
  }
  await reachable.end();

  // env.ts parses at import time: the parity URL must be in place BEFORE the
  // first dynamic import below touches src/common/config/env.ts. Assign
  // UNCONDITIONALLY — the lane owns its database; a caller-supplied
  // DATABASE_URL pointing at the live `neryva` DB must never be inherited
  // (the parity spec is forbidden from touching the live database).
  process.env.DATABASE_URL = pgUrl;

  const { DbService } = await import('../../../common/infra/db/db.service');
  const emailCodesMod = await import('./pg-email-code.repository');
  const refreshTokensMod = await import('./pg-refresh-token.repository');
  const sessionsMod = await import('./pg-session.repository');
  const accountsMod = await import('./pg-account.repository');
  PgEmailCodeRepositoryCtor = emailCodesMod.PgEmailCodeRepository;
  PgRefreshTokenRepositoryCtor = refreshTokensMod.PgRefreshTokenRepository;
  PgSessionRepositoryCtor = sessionsMod.PgSessionRepository;
  PgAccountRepositoryCtor = accountsMod.PgAccountRepository;

  const setupPool = new Pool({ connectionString: pgUrl, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const repos = {
    emailCodes: new PgEmailCodeRepositoryCtor(db as never),
    refreshTokens: new PgRefreshTokenRepositoryCtor(db as never),
    sessions: new PgSessionRepositoryCtor(db as never),
    accounts: new PgAccountRepositoryCtor(db as never),
  };
  return {
    name: 'pg',
    emailCodes: () => repos.emailCodes,
    refreshTokens: () => repos.refreshTokens,
    sessions: () => repos.sessions,
    accounts: () => repos.accounts,
    teardown: async () => {
      await db.onModuleDestroy().catch(() => undefined);
    },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-ident-parity-${process.pid}`;
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

  const emailCodesMod = await import('./mongo-email-code.repository');
  const refreshTokensMod = await import('./mongo-refresh-token.repository');
  const sessionsMod = await import('./mongo-session.repository');
  const accountsMod = await import('./mongo-account.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoEmailCodeRepositoryCtor = emailCodesMod.MongoEmailCodeRepository;
  MongoRefreshTokenRepositoryCtor = refreshTokensMod.MongoRefreshTokenRepository;
  MongoSessionRepositoryCtor = sessionsMod.MongoSessionRepository;
  MongoAccountRepositoryCtor = accountsMod.MongoAccountRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  const db = client.db('neryva_ident_parity');
  await runMongoMigrationsFn(db);

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

  const repos = {
    emailCodes: new MongoEmailCodeRepositoryCtor(deps as never),
    refreshTokens: new MongoRefreshTokenRepositoryCtor(deps as never),
    sessions: new MongoSessionRepositoryCtor(deps as never),
    accounts: new MongoAccountRepositoryCtor(deps as never),
  };
  return {
    name: 'mongo',
    emailCodes: () => repos.emailCodes,
    refreshTokens: () => repos.refreshTokens,
    sessions: () => repos.sessions,
    accounts: () => repos.accounts,
    teardown: async () => {
      await client.close().catch(() => undefined);
      await replSet.stop().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function makeAccount(lane: Lane, email: string): Promise<string> {
  const { account } = await lane.accounts().upsertByEmail(email);
  return account.id;
}

const CODE = '123456';
const codeHashOf = (code: string): string => sha256Hex(code);

interface RefreshSeed {
  jti: string;
  familyId: string;
  sessionId: string | null;
  grantId: string | null;
}

async function upsertRefresh(
  lane: Lane,
  seed: RefreshSeed,
  opts: { rotatedFrom?: string | null } = {},
): Promise<void> {
  await lane.refreshTokens().upsert({
    jti: seed.jti,
    familyId: seed.familyId,
    sessionId: seed.sessionId,
    tokenHash: sha256Hex(`tok-${seed.jti}`),
    grantId: seed.grantId,
    expiresAt: futureIso(3600_000),
    rotatedFrom: opts.rotatedFrom ?? null,
    nowIso: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pgLane = await buildPgLane();
  mongoLane = await buildMongoLane();
  if (!pgLane && !mongoLane) {
    throw new Error('no parity lane available — pg and mongo both failed to start');
  }
}, 120_000);

afterAll(async () => {
  await pgLane?.teardown();
  await mongoLane?.teardown();
});

function laneScenarios(laneName: string, getLane: () => Lane | null): void {
  const need = (): Lane | null => {
    const lane = getLane();
    if (!lane) console.warn(`[parity] ${laneName} lane unavailable — scenario skipped`);
    return lane;
  };

  describe(`identity parity — ${laneName} lane`, () => {
  const tag = (): string => `${laneName}-${randomUUID().slice(0, 8)}`;

  it('a. email-code concurrent verify-and-burn: exactly one winner', async () => {
    const l = need();
    if (!l) return;
    const accountId = await makeAccount(l, `code-a-${tag()}@example.com`);
    const hash = codeHashOf(CODE);
    await l.emailCodes().issue(accountId, hash, null, futureIso(600_000), nowIso());

    // verify read sees the live code
    const live = await l.emailCodes().findLive(accountId, hash);
    expect(live).not.toBeNull();
    expect(live?.codeHash).toBe(hash);

    // 8 parallel consumers race the single-use CAS
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => l.emailCodes().consume(accountId, hash)),
    );
    const wins = outcomes.filter(Boolean).length;
    expect(wins).toBe(1);

    // burned: the verify read no longer sees it
    expect(await l.emailCodes().findLive(accountId, hash)).toBeNull();
    // second burn attempt is a no-op
    expect(await l.emailCodes().consume(accountId, hash)).toBe(false);
  });

  it('b. email-code issue voids previous codes; failed attempts accrue', async () => {
    const l = need();
    if (!l) return;
    const accountId = await makeAccount(l, `code-b-${tag()}@example.com`);
    const first = codeHashOf('111111');
    const second = codeHashOf('222222');
    await l.emailCodes().issue(accountId, first, null, futureIso(600_000), nowIso());
    expect(await l.emailCodes().findLive(accountId, first)).not.toBeNull();

    await l.emailCodes().issue(accountId, second, null, futureIso(600_000), nowIso());
    // the fresh issue voided the previous code
    expect(await l.emailCodes().findLive(accountId, first)).toBeNull();
    expect(await l.emailCodes().findLive(accountId, second)).not.toBeNull();

    // failed attempts accrue on the live row (account-wide, unconsumed rows)
    await l.emailCodes().registerFailedAttempt(accountId);
    await l.emailCodes().registerFailedAttempt(accountId);
    const row = await l.emailCodes().findLive(accountId, second);
    expect(row?.attempts).toBe(2);
  });

  it('c. refresh rotation + reuse tripwire: family revoked exactly once', async () => {
    const l = need();
    if (!l) return;
    const familyId = randomUUID();
    const seedA: RefreshSeed = { jti: `rt-a-${tag()}`, familyId, sessionId: null, grantId: `g-${tag()}` };
    const seedB: RefreshSeed = { jti: `rt-b-${tag()}`, familyId, sessionId: null, grantId: seedA.grantId };
    await upsertRefresh(l, seedA);
    // rotation: B inserted, A stamped consumed
    await upsertRefresh(l, seedB, { rotatedFrom: seedA.jti });

    const rowA = await l.refreshTokens().findByJti(seedA.jti);
    expect(rowA?.consumedAt).not.toBeNull();
    expect(rowA?.rotatedFrom).toBeNull();

    // presenting the consumed predecessor trips the reuse wire
    const first = await l.refreshTokens().consumeWithReuseDetection(seedA.jti, nowIso());
    expect(first.status).toBe('reused');
    if (first.status === 'reused') {
      expect(first.familyId).toBe(familyId);
      expect(first.firstDetection).toBe(true);
    }

    // the whole family is revoked (revokedAt + retiredAt on every member)
    for (const seed of [seedA, seedB]) {
      const row = await l.refreshTokens().findByJti(seed.jti);
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.retiredAt).not.toBeNull();
    }

    // repeat replay: still refused, but the alert fires only once
    const repeat = await l.refreshTokens().consumeWithReuseDetection(seedA.jti, nowIso());
    expect(repeat.status).toBe('reused');
    if (repeat.status === 'reused') {
      expect(repeat.firstDetection).toBe(false);
    }

    // the live successor is dead too — the refresh grant refuses revoked rows
    const dead = await l.refreshTokens().consumeWithReuseDetection(seedB.jti, nowIso());
    expect(dead.status).toBe('reused');
  });

  it('d. refresh rotation concurrency: one consumer, the rest trip the wire', async () => {
    const l = need();
    if (!l) return;
    const familyId = randomUUID();
    const seed: RefreshSeed = { jti: `rt-c-${tag()}`, familyId, sessionId: null, grantId: null };
    await upsertRefresh(l, seed);

    const outcomes: RefreshConsumeOutcome[] = await Promise.all(
      Array.from({ length: 8 }, () => l.refreshTokens().consumeWithReuseDetection(seed.jti, nowIso())),
    );
    const consumed = outcomes.filter((o) => o.status === 'consumed').length;
    const reused = outcomes.filter((o) => o.status === 'reused').length;
    expect(consumed).toBe(1);
    expect(reused).toBe(7);

    // the losers tripped the reuse wire → the family is revoked exactly once
    const firstDetections = outcomes.filter(
      (o): o is Extract<RefreshConsumeOutcome, { status: 'reused' }> =>
        o.status === 'reused' && o.firstDetection,
    ).length;
    expect(firstDetections).toBe(1);

    const row = await l.refreshTokens().findByJti(seed.jti);
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.retiredAt).not.toBeNull();
  });

  it('e. refresh grant cascade: revokeByGrantId retires the grant only', async () => {
    const l = need();
    if (!l) return;
    const grant = `grant-${tag()}`;
    const other = `grant-${tag()}-other`;
    const seeds: RefreshSeed[] = [
      { jti: `rt-g1-${tag()}`, familyId: randomUUID(), sessionId: null, grantId: grant },
      { jti: `rt-g2-${tag()}`, familyId: randomUUID(), sessionId: null, grantId: grant },
      { jti: `rt-g3-${tag()}`, familyId: randomUUID(), sessionId: null, grantId: other },
    ];
    for (const s of seeds) await upsertRefresh(l, s);

    await l.refreshTokens().revokeByGrantId(grant, nowIso());

    for (const s of seeds.slice(0, 2)) {
      const row = await l.refreshTokens().findByJti(s.jti);
      expect(row?.revokedAt).not.toBeNull();
    }
    const untouched = await l.refreshTokens().findByJti(seeds[2].jti);
    expect(untouched?.revokedAt).toBeNull();
  });

  it('f. session revocation: account-scoped CAS, listActive hides revoked', async () => {
    const l = need();
    if (!l) return;
    const accountId = await makeAccount(l, `sess-f-${tag()}@example.com`);
    const otherId = await makeAccount(l, `sess-f2-${tag()}@example.com`);
    const sid = `sid-${tag()}`;
    const uid = `uid-${tag()}`;
    await l.sessions().upsertSessionRow({
      sid,
      accountId,
      clientId: 'neryva-console',
      familyId: randomUUID(),
      sessionUid: uid,
      device: { ua: 'parity' },
      nowIso: nowIso(),
    });

    const active = await l.sessions().listActive(accountId, 10);
    expect(active.some((s) => s.sid === sid)).toBe(true);

    // another account cannot revoke it (CAS matches nothing → 404 mapping)
    expect(await l.sessions().revokeOne(otherId, sid, nowIso())).toBeNull();
    expect((await l.sessions().listActive(accountId, 10)).some((s) => s.sid === sid)).toBe(true);

    // the owner revokes it: row identity returned for deny-list fan-out
    const revoked = await l.sessions().revokeOne(accountId, sid, nowIso());
    expect(revoked).not.toBeNull();
    expect(revoked?.sid).toBe(sid);
    expect(revoked?.sessionUid).toBe(uid);

    expect((await l.sessions().listActive(accountId, 10)).some((s) => s.sid === sid)).toBe(false);
    // double revoke is a no-op (already revoked → CAS matches nothing)
    expect(await l.sessions().revokeOne(accountId, sid, nowIso())).toBeNull();
  });

  it('g. session revocation fan-out: revokeByJtis retires refresh tokens', async () => {
    const l = need();
    if (!l) return;
    const familyId = randomUUID();
    const seed: RefreshSeed = { jti: `rt-s-${tag()}`, familyId, sessionId: `sid-${tag()}`, grantId: null };
    await upsertRefresh(l, seed);

    await l.refreshTokens().revokeByJtis([seed.jti], nowIso());
    const row = await l.refreshTokens().findByJti(seed.jti);
    expect(row?.revokedAt).not.toBeNull();
    // Note: revokeByJtis sets revokedAt only (the original behavior);
    // retiredAt is set by the family-revocation tripwire, not here.

    // a revoked token cannot be consumed for rotation
    const outcome = await l.refreshTokens().consumeWithReuseDetection(seed.jti, nowIso());
    expect(outcome.status).toBe('reused');
  });

  it('h. session uid revocation + guard join (reuse-tripwire path)', async () => {
    const l = need();
    if (!l) return;
    const accountId = await makeAccount(l, `sess-h-${tag()}@example.com`);
    const sid = `sid-h-${tag()}`;
    const uid = `uid-h-${tag()}`;
    await l.sessions().upsertSessionRow({
      sid,
      accountId,
      clientId: 'neryva-console',
      familyId: randomUUID(),
      sessionUid: uid,
      device: {},
      nowIso: nowIso(),
    });

    // the guard join resolves account + status for the deny-list fan-out
    const guard = await l.sessions().findSessionGuard(sid);
    expect(guard?.accountId).toBe(accountId);
    expect(guard?.status).toBe('active');

    // the reuse tripwire revokes by OIDC session.uid (the JWT `sid` claim)
    await l.sessions().revokeBySessionUid(uid, nowIso());
    expect(await l.sessions().findAccountIdBySessionUid(uid)).toBe(accountId);
    expect((await l.sessions().listActive(accountId, 10)).some((s) => s.sid === sid)).toBe(false);

    // the provider's session-destroy path returns the row identity
    const bySid = await l.sessions().revokeBySid(sid, nowIso());
    expect(bySid?.accountId).toBe(accountId);
    expect(bySid?.sessionUid).toBe(uid);
  });

  it('i. kill-switch: revokeAllSessions stamps the timestamp and marks session rows', async () => {
    const l = need();
    if (!l) return;
    const accountId = await makeAccount(l, `sess-i-${tag()}@example.com`);
    const otherId = await makeAccount(l, `sess-i2-${tag()}@example.com`);
    for (const n of [1, 2]) {
      await l.sessions().upsertSessionRow({
        sid: `sid-i${n}-${tag()}`,
        accountId,
        clientId: 'neryva-console',
        familyId: randomUUID(),
        sessionUid: `uid-i${n}-${tag()}`,
        device: {},
        nowIso: nowIso(),
      });
    }
    await l.sessions().upsertSessionRow({
      sid: `sid-i-other-${tag()}`,
      accountId: otherId,
      clientId: 'neryva-console',
      familyId: randomUUID(),
      sessionUid: `uid-i-other-${tag()}`,
      device: {},
      nowIso: nowIso(),
    });
    expect((await l.sessions().listActive(accountId, 10)).length).toBe(2);

    const stamp = nowIso();
    await l.accounts().revokeAllSessions(accountId, stamp);

    // the timestamp kill-switch is stamped on the account row …
    // (compared as instants: the pg lane returns the timestamptz in the
    // driver's text format, the mongo lane the ISO string as stored)
    const guard = await l.accounts().sessionGuardState(accountId);
    expect(new Date(guard?.sessionsRevokedAt ?? 0).getTime()).toBe(new Date(stamp).getTime());
    // … and the session rows are marked revoked so listActive hides them
    expect(await l.sessions().listActive(accountId, 10)).toEqual([]);
    // another account's sessions are untouched
    expect((await l.sessions().listActive(otherId, 10)).length).toBe(1);
  });
  });
}

describe('identity repository parity', () => {
  laneScenarios('pg', () => pgLane);
  laneScenarios('mongo', () => mongoLane);
});
