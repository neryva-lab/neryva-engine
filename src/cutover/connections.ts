/**
 * Shared cutover infrastructure: DB connections, safety guards, resume state.
 *
 * Safety rules (fail-closed):
 * - The pg source/target MUST come from `CUTOVER_PG_URL` explicitly.
 * - Refuse if the pg URL points at a database named exactly `neryva`
 *   (the live database). Cutover runs against `neryva_parity` or a dump
 *   restore, never live.
 * - The mongo target MUST come from `CUTOVER_MONGO_URI` explicitly.
 * - `pg-to-mongo` refuses when the mongo target already holds data in ANY
 *   registry collection, unless `--force` is passed (with a big warning).
 * - `pg-to-mongo` verifies `runMongoMigrations` ran by checking the
 *   `mongo_migrations` ledger for the registered versions; fails closed
 *   if any are missing.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { MongoClient, type Db } from 'mongodb';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { CUTOVER_REGISTRY } from './registry';
import { MONGO_MIGRATIONS_COLLECTION } from '../common/infra/db/mongo/migrations/mongo-migrator';
import { MONGO_MIGRATION_REGISTRY } from '../common/infra/db/mongo/migrations/mongo/index';

/** Never commit this file. */
export const STATE_FILE = './.cutover-state.json';

export interface CutoverState {
  /** mongoName → true when verify passed for that collection. */
  verified: Record<string, boolean>;
  updatedAt: string;
}

export async function loadState(): Promise<CutoverState> {
  if (!existsSync(STATE_FILE)) {
    return { verified: {}, updatedAt: new Date().toISOString() };
  }
  const raw = await readFile(STATE_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as CutoverState;
  if (!parsed.verified || typeof parsed.verified !== 'object') {
    throw new Error(`cutover: corrupt state file ${STATE_FILE} — delete it to start fresh`);
  }
  return parsed;
}

export async function saveState(state: CutoverState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/** Extract the database name from a postgres URL. */
function pgDatabaseName(url: string): string {
  const m = url.match(/\/([^/?]+)(\?|$)/);
  if (!m) throw new Error('cutover: cannot parse database name from CUTOVER_PG_URL');
  return decodeURIComponent(m[1]);
}

export interface PgHandle {
  pool: Pool;
  db: ReturnType<typeof drizzle>;
  /** Raw SQL executor for COUNT(*) and paginated SELECTs. */
  execute: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** Raw query returning the full pg result (for INSERT rowCount). */
  query: (query: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  close: () => Promise<void>;
}

/** Connect to PostgreSQL via CUTOVER_PG_URL. Fails closed on live `neryva`. */
export async function connectPg(): Promise<PgHandle> {
  const url = process.env.CUTOVER_PG_URL;
  if (!url) {
    throw new Error('cutover: CUTOVER_PG_URL is required (refusing to guess the pg endpoint)');
  }
  const dbName = pgDatabaseName(url);
  if (dbName === 'neryva') {
    throw new Error(
      'cutover: CUTOVER_PG_URL points at the live `neryva` database — refusing. ' +
        'Use neryva_parity or a restored dump.',
    );
  }
  const pool = new Pool({ connectionString: url, max: 5 });
  // Smoke-test the connection.
  await pool.query('SELECT 1');
  const db = drizzle(pool);
  return {
    pool,
    db,
    execute: async (query: string, params: unknown[] = []) => {
      const res = await pool.query(query, params);
      return res.rows as Record<string, unknown>[];
    },
    query: async (query: string, params: unknown[] = []) => {
      const res = await pool.query(query, params);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
    },
    close: async () => {
      await pool.end();
    },
  };
}

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  close: () => Promise<void>;
}

/** Connect to MongoDB via CUTOVER_MONGO_URI. */
export async function connectMongo(): Promise<MongoHandle> {
  const uri = process.env.CUTOVER_MONGO_URI;
  if (!uri) {
    throw new Error('cutover: CUTOVER_MONGO_URI is required (refusing to guess the mongo endpoint)');
  }
  const client = new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  const db = client.db();
  return {
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Fail closed unless every registered mongo migration is recorded in the
 * `mongo_migrations` ledger. Run `runMongoMigrations` (release job) first.
 */
export async function assertMigrationsApplied(db: Db): Promise<void> {
  const ledger = db.collection<{ _id: string }>(MONGO_MIGRATIONS_COLLECTION);
  const missing: string[] = [];
  for (const { migration } of MONGO_MIGRATION_REGISTRY) {
    const doc = await ledger.findOne({ _id: migration.version });
    if (!doc) missing.push(migration.version);
  }
  if (missing.length > 0) {
    throw new Error(
      `cutover: mongo migrations not applied (missing: ${missing.join(', ')}). ` +
        'Run the release-job `runMongoMigrations` first — refusing to cut over onto an unmigrated DB.',
    );
  }
}

/**
 * Count documents in every registry collection. Used for the fresh-target
 * guard: pg-to-mongo refuses when ANY collection already holds data.
 */
export async function mongoCollectionCounts(db: Db): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const coll of CUTOVER_REGISTRY) {
    const n = await db.collection(coll.mongoName).countDocuments();
    counts.set(coll.mongoName, n);
  }
  return counts;
}

/** Print the big warning for --force. */
export function printForceWarning(nonEmpty: [string, number][]): void {
  console.warn('');
  console.warn('╔════════════════════════════════════════════════════════════════╗');
  console.warn('║  WARNING: --force passed with a NON-EMPTY mongo target        ║');
  console.warn('╠════════════════════════════════════════════════════════════════╣');
  for (const [name, count] of nonEmpty.slice(0, 10)) {
    console.warn(`║  ${name.padEnd(40)} ${String(count).padStart(10)} docs ║`);
  }
  if (nonEmpty.length > 10) {
    console.warn(`║  ... and ${nonEmpty.length - 10} more collections`.padEnd(65) + ' ║');
  }
  console.warn('║                                                                ║');
  console.warn('║  Writes use upsert-on-id so re-runs are safe, but pre-existing ║');
  console.warn('║  documents with the same id will NOT be overwritten.           ║');
  console.warn('╚════════════════════════════════════════════════════════════════╝');
  console.warn('');
}

/** pg COUNT(*) for a collection's table. */
export async function pgCount(pg: PgHandle, pgQuoted: string): Promise<number> {
  const rows = await pg.execute(`SELECT COUNT(*)::int AS c FROM ${pgQuoted}`);
  return Number(rows[0]?.c ?? 0);
}
