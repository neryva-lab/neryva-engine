import type { INestApplication } from '@nestjs/common';
import { env } from './env';
import { ModuleFlags } from './feature-flags';
import { MongoDbService } from '../infra/db/mongo/mongo.service';
import { listPendingMongoMigrations } from '../infra/db/mongo/migrations/mongo-migrator';
// Pure functions only (no DI, no side effects): the resolver stays the
// SINGLE place the search backend is chosen; this module reuses it for
// the boot pre-flight instead of duplicating the priority rules.
import {
  isAtlasTopology,
  resolveSearchBackendKind,
} from '../../modules/knowledge/search/search-backend';

/**
 * Provider readiness — fail-closed boot validation for selectable
 * persistence (P5).
 *
 * Two phases, both on the existing boot path (`main.ts` → `bootstrap()`):
 *
 * 1. `assertProviderEnvReady()` — pure, no I/O. Runs FIRST in bootstrap,
 *    before Nest does any work. Catches misconfiguration that zod's schema
 *    cannot express (e.g. `MONGODB_URI` with a non-mongo scheme, which
 *    `z.string().url()` accepts).
 * 2. `assertProviderReady(app)` — live checks against the connected lane.
 *    Runs after `app.init()` (all `onModuleInit` hooks, including the
 *    Mongo lane's eager connect) and before `app.listen()`, so the process
 *    never serves traffic on a half-ready database.
 *
 * Every failure throws `ProviderReadinessError` whose message states: what
 * is wrong, which env var is involved, and what a correct value looks
 * like. The message is the whole report — no stack trace needed to act.
 */
export class ProviderReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderReadinessError';
  }
}

const fail = (message: string): never => {
  throw new ProviderReadinessError(message);
};

/** MongoDB URI schemes the driver understands. */
function assertMongoScheme(uri: string): void {
  const lower = uri.trim().toLowerCase();
  if (lower.startsWith('mongodb://') || lower.startsWith('mongodb+srv://')) return;
  fail(
    'MONGODB_URI has an unsupported scheme: the value must start with ' +
      '`mongodb://` (self-hosted / replica set) or `mongodb+srv://` (Atlas / SRV). ' +
      `Got: '${redactCredentials(uri)}'. ` +
      "Example: 'mongodb://app-user:<password>@mongo-1:27017,mongo-2:27017/neryva?replicaSet=rs0&authSource=admin'.",
  );
}

/** Never echo passwords into a boot log. */
function redactCredentials(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '<redacted>';
    return u.toString();
  } catch {
    return '<unparseable>';
  }
}

/**
 * Phase 1 — static environment validation. No I/O, no side effects.
 * Safe to call before anything else in the process.
 */
export function assertProviderEnvReady(): void {
  const provider = env.DB_PROVIDER;
  if (provider !== 'postgres' && provider !== 'mongodb') {
    fail(
      `DB_PROVIDER has an unsupported value '${provider}': it must be exactly ` +
        "'postgres' or 'mongodb' (lowercase). Unset it to use the default 'postgres'.",
    );
  }

  if (provider === 'postgres') {
    if (!env.DATABASE_URL) {
      fail(
        'DATABASE_URL is not set: DB_PROVIDER=postgres requires a PostgreSQL ' +
          "connection string. Example: 'postgresql://neryva_app:<password>@127.0.0.1:5432/neryva'.",
      );
    }
    return;
  }

  // provider === 'mongodb'
  const maybeUri: string | undefined = env.MONGODB_URI;
  if (maybeUri === undefined || maybeUri === '') {
    // The env superRefine also enforces this; this message is the actionable one.
    // (Thrown directly — not via fail() — so control-flow narrowing applies.)
    throw new ProviderReadinessError(
      'MONGODB_URI is not set: DB_PROVIDER=mongodb requires a MongoDB ' +
        "connection string. Example: 'mongodb://app-user:<password>@mongo-1:27017,mongo-2:27017/neryva?replicaSet=rs0&authSource=admin'.",
    );
  }
  const uri: string = maybeUri;
  assertMongoScheme(uri);

  // The publish-lease TTL is zod-bounded (30s default, 1h max); assert the
  // contract explicitly so a future schema relaxation still fails closed.
  const ttl = env.MONGODB_PUBLISH_LEASE_TTL_MS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 3_600_000) {
    fail(
      `MONGODB_PUBLISH_LEASE_TTL_MS=${ttl} is out of range: it must be a ` +
        'positive integer number of milliseconds, at most 3600000 (1 hour). ' +
        "The default 30000 (30s) is correct for most deployments; raise it " +
        'only if legitimate publishes routinely exceed 30s.',
    );
  }
}

/** Minimal HTTP liveness probe (mirrors the knowledge module's Qdrant probe). */
async function probeHttp(url: string, timeoutMs = 3000): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `GET / → HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Phase 2 — live readiness against the connected lane. Call after
 * `app.init()` (providers' `onModuleInit` hooks have run, including the
 * Mongo lane's eager connect) and before `app.listen()`.
 */
export async function assertProviderReady(app: INestApplication): Promise<void> {
  // Belt and braces: the static phase already ran in bootstrap(); re-run
  // so this function is also correct when called standalone (tests, CLIs).
  assertProviderEnvReady();

  if (env.DB_PROVIDER !== 'mongodb') return;

  const mongo = app.get(MongoDbService, { strict: false });
  const db = mongo.root; // throws a clear error if the lane failed to initialize

  // 1. Topology: multi-document transactions require a replica set (or
  //    mongos). MongoDbService already enforces this at connect; re-assert
  //    here so the readiness report names the requirement explicitly.
  const hello = (await db.admin().command({ hello: 1 })) as {
    setName?: string;
    msg?: string;
  };
  const setName = hello.setName;
  const isMongos = hello.msg === 'isdbgrid';
  if (!setName && !isMongos) {
    fail(
      'MongoDB topology is not a replica set: the server answered `hello` ' +
        'without a setName, so multi-document transactions are unavailable ' +
        'and every transactional invariant would silently break. ' +
        'MONGODB_URI must target a replica set (start mongod with --replSet ' +
        'and initiate it; a single-node replica set is fine for dev/CI) or a ' +
        'sharded cluster (mongos).',
    );
  }

  // 2. Migrations: never boot the app on an unmigrated database. The
  //    release job owns application (`runMongoMigrations`); this probe is
  //    read-only and fails closed on any gap.
  const pending = await listPendingMongoMigrations(db);
  if (pending.length > 0) {
    const lines = pending
      .map((p) => `  - ${p.version} (${p.tag}): ${p.reason === 'not-applied' ? 'not in the mongo_migrations ledger' : 'ledger checksum no longer matches the migration code'}`)
      .join('\n');
    fail(
      `MongoDB migrations are not fully applied: ${pending.length} registered migration(s) missing from the database:\n${lines}\n` +
        'Run the MongoDB migration release job (`runMongoMigrations` from ' +
        'src/common/infra/db/mongo/migrations/mongo-migrator.ts) against the ' +
        'database MONGODB_URI points at, then reboot. The app never applies ' +
        'migrations itself (release-job-only, like `drizzle-kit migrate`).',
    );
  }

  // 3. Search backend pre-flight (only when the knowledge plane is
  //    enabled — otherwise no vector backend is needed). Uses the same
  //    pure resolver as the knowledge module's DI factory; the factory
  //    remains the instantiation authority.
  if (ModuleFlags.knowledge && !isAtlasTopology(env.MONGODB_URI ?? '')) {
    const qdrantUrl = env.QDRANT_URL;
    const probe = qdrantUrl
      ? await probeHttp(qdrantUrl)
      : { ok: false as const, error: 'QDRANT_URL is not set' };
    try {
      resolveSearchBackendKind({
        dbProvider: 'mongodb',
        mongoUri: env.MONGODB_URI,
        qdrantUrl,
        qdrantReachable: probe.ok,
        qdrantProbeError: probe.error,
      });
    } catch (err) {
      // The resolver's message already carries the exact remediation.
      fail((err as Error).message);
    }
  }
}
