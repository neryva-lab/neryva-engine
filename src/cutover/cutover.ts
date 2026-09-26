/**
 * Cutover CLI: PostgreSQL ↔ MongoDB data migration.
 *
 * Usage:
 *   npx tsx src/cutover/cutover.ts pg-to-mongo [--dry-run] [--force] [--collection <name>] [--batch-size <n>] [--resume]
 *   npx tsx src/cutover/cutover.ts mongo-to-pg [--dry-run] [--collection <name>] [--batch-size <n>] [--resume]
 *   npx tsx src/cutover/cutover.ts verify [--collection <name>] [--batch-size <n>] [--resume]
 *
 * Environment (all required, explicit — never guessed):
 *   CUTOVER_PG_URL     postgres connection string (refuses database named exactly `neryva`)
 *   CUTOVER_MONGO_URI  mongodb connection string
 *
 * Copy semantics (both directions):
 * - pg→mongo: `bulkWrite` with `updateOne({id}, {$setOnInsert: doc}, {upsert: true})`,
 *   `ordered: false`, batches of --batch-size. Idempotent and re-runnable:
 *   existing documents are never overwritten.
 * - mongo→pg: drizzle `insert(...).onConflictDoNothing()`, batched.
 *   Existing rows are never overwritten.
 *
 * Safety:
 * - `pg-to-mongo` requires the mongo target to be EMPTY (all 133 collections)
 *   unless `--force` is passed (with a big warning). Cutover normally runs
 *   onto a fresh DB where `runMongoMigrations` has just run.
 * - `pg-to-mongo` fails closed unless the `mongo_migrations` ledger shows
 *   every registered migration as applied.
 * - `--resume` skips collections already marked verified in `.cutover-state.json`.
 *   `verify` marks passing collections in the state file.
 */
import { CUTOVER_REGISTRY, getCollection, collectionsWithoutSchema } from './registry';
import { pgRowToMongoDoc, mongoDocToPgRow } from './mappers';
import {
  connectPg,
  connectMongo,
  assertMigrationsApplied,
  mongoCollectionCounts,
  printForceWarning,
  loadState,
  saveState,
  type PgHandle,
  type MongoHandle,
} from './connections';
import { verifyAll, printVerifyTable, dryRunReport } from './verify';
import type { CollectionMapping } from './registry';

interface Args {
  command: string;
  dryRun: boolean;
  force: boolean;
  resume: boolean;
  collection?: string;
  batchSize: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[2] ?? '',
    dryRun: false,
    force: false,
    resume: false,
    batchSize: 1000,
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--collection') args.collection = argv[++i];
    else if (a === '--batch-size') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('cutover: --batch-size must be a positive integer');
      }
      args.batchSize = n;
    } else {
      throw new Error(`cutover: unknown flag ${a}`);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
cutover — PostgreSQL ↔ MongoDB data migration CLI

  cutover pg-to-mongo [--dry-run] [--force] [--collection <name>] [--batch-size <n>] [--resume]
  cutover mongo-to-pg [--dry-run] [--collection <name>] [--batch-size <n>] [--resume]
  cutover verify [--collection <name>] [--batch-size <n>] [--resume]

env: CUTOVER_PG_URL, CUTOVER_MONGO_URI (both required)
`);
}

/** Copy one collection pg → mongo. Returns rows copied. */
async function copyPgToMongo(
  pg: PgHandle,
  mongo: MongoHandle,
  mapping: CollectionMapping,
  batchSize: number,
): Promise<{ copied: number; skipped: number }> {
  const coll = mongo.db.collection(mapping.mongoName);
  let copied = 0;
  let skipped = 0;
  let offset = 0;

  for (;;) {
    const rows = await pg.execute(
      `SELECT * FROM ${mapping.pgQuoted} ORDER BY ${mapping.pkColumn} LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );
    if (rows.length === 0) break;

    const ops = [];
    for (const row of rows) {
      const { doc } = pgRowToMongoDoc(row, mapping);
      const id = doc[mapping.pkColumn];
      ops.push({
        updateOne: {
          filter: { [mapping.pkColumn]: id },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      });
    }

    const res = await coll.bulkWrite(ops, { ordered: false });
    copied += res.upsertedCount;
    // Matched-but-not-modified = already present (skipped by $setOnInsert).
    skipped += res.matchedCount;

    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  return { copied, skipped };
}

/** Copy one collection mongo → pg. Returns rows copied. */
async function copyMongoToPg(
  pg: PgHandle,
  mongo: MongoHandle,
  mapping: CollectionMapping,
  batchSize: number,
): Promise<{ copied: number; skipped: number }> {
  const coll = mongo.db.collection(mapping.mongoName);
  let copied = 0;
  let skipped = 0;
  let lastId: unknown = null;

  // Build the INSERT via raw SQL to stay table-agnostic. Columns come from
  // the first mapped row; all rows in a collection share the shape.
  for (;;) {
    const filter = lastId === null ? {} : { [mapping.pkColumn]: { $gt: lastId } };
    const docs = await coll
      .find(filter)
      .sort({ [mapping.pkColumn]: 1 })
      .limit(batchSize)
      .toArray();
    if (docs.length === 0) break;

    const mapped = docs.map((d) => mongoDocToPgRow(d as Record<string, unknown>, mapping).row);
    const columns = Object.keys(mapped[0] ?? {});
    if (columns.length === 0) break;

    // Batched multi-row INSERT ... ON CONFLICT (pk) DO NOTHING.
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const row of mapped) {
      const ph = columns.map((c) => {
        values.push(row[c]);
        return `$${values.length}`;
      });
      placeholders.push(`(${ph.join(', ')})`);
    }
    const colsQuoted = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
    const res = await pg.query(
      `INSERT INTO ${mapping.pgQuoted} (${colsQuoted}) VALUES ${placeholders.join(', ')} ` +
        `ON CONFLICT (${mapping.pkColumn}) DO NOTHING`,
      values,
    );
    const inserted = res.rowCount ?? 0;
    copied += inserted;
    skipped += mapped.length - inserted;

    lastId = (docs[docs.length - 1] as Record<string, unknown>)[mapping.pkColumn];
    if (docs.length < batchSize) break;
  }

  return { copied, skipped };
}

async function cmdPgToMongo(pg: PgHandle, mongo: MongoHandle, args: Args): Promise<void> {
  // 1. Migrations must have run.
  await assertMigrationsApplied(mongo.db);

  // 2. Fresh-target guard.
  const counts = await mongoCollectionCounts(mongo.db);
  const nonEmpty = [...counts.entries()].filter(([, n]) => n > 0);
  if (nonEmpty.length > 0 && !args.force) {
    throw new Error(
      `cutover: mongo target is not empty (${nonEmpty.length} collections hold data, e.g. ` +
        `${nonEmpty[0][0]}: ${nonEmpty[0][1]} docs). Pass --force to cut over anyway ` +
        `(writes are upsert-on-id; existing docs are never overwritten).`,
    );
  }
  if (nonEmpty.length > 0 && args.force) {
    printForceWarning(nonEmpty);
  }

  // 3. Warn about collections without drizzle schema (heuristic fallback).
  const noSchema = collectionsWithoutSchema();
  if (noSchema.length > 0) {
    console.warn(
      `cutover: ${noSchema.length} collections have no drizzle table — ` +
        'mapper falls back to passthrough for unknown columns:',
    );
    for (const c of noSchema.slice(0, 10)) console.warn(`  - ${c.mongoName} (pg: ${c.pgTable})`);
    if (noSchema.length > 10) console.warn(`  ... and ${noSchema.length - 10} more`);
  }

  const state = args.resume ? await loadState() : { verified: {} as Record<string, boolean>, updatedAt: '' };
  let totalCopied = 0;
  let totalSkipped = 0;

  for (const mapping of CUTOVER_REGISTRY) {
    if (args.collection && mapping.mongoName !== args.collection) continue;
    if (args.resume && state.verified[mapping.mongoName]) {
      console.log(`[skip] ${mapping.mongoName} (already verified)`);
      continue;
    }
    const { copied, skipped } = await copyPgToMongo(pg, mongo, mapping, args.batchSize);
    totalCopied += copied;
    totalSkipped += skipped;
    console.log(`[copy] ${mapping.mongoName}: ${copied} inserted, ${skipped} already present`);
  }

  console.log(`\ndone: ${totalCopied} inserted, ${totalSkipped} already present`);
}

async function cmdMongoToPg(pg: PgHandle, mongo: MongoHandle, args: Args): Promise<void> {
  const state = args.resume ? await loadState() : { verified: {} as Record<string, boolean>, updatedAt: '' };
  let totalCopied = 0;

  for (const mapping of CUTOVER_REGISTRY) {
    if (args.collection && mapping.mongoName !== args.collection) continue;
    if (args.resume && state.verified[mapping.mongoName]) {
      console.log(`[skip] ${mapping.mongoName} (already verified)`);
      continue;
    }
    const { copied } = await copyMongoToPg(pg, mongo, mapping, args.batchSize);
    totalCopied += copied;
    console.log(`[copy] ${mapping.mongoName}: ${copied} rows written (upsert-on-pk)`);
  }

  console.log(`\ndone: ${totalCopied} rows written`);
}

async function cmdVerify(pg: PgHandle, mongo: MongoHandle, args: Args): Promise<void> {
  const state = await loadState();
  const skipVerified = args.resume ? new Set(Object.keys(state.verified).filter((k) => state.verified[k])) : new Set<string>();

  if (args.collection && !getCollection(args.collection)) {
    throw new Error(`cutover: unknown collection ${args.collection}`);
  }

  const results = await verifyAll(pg, mongo, {
    batchSize: args.batchSize,
    skipVerified,
    onlyCollection: args.collection,
  });

  const allOk = printVerifyTable(results);

  // Mark passing collections in the state file (resume support).
  let dirty = false;
  for (const r of results) {
    if (r.countMatch && r.checksumMatch) {
      if (!state.verified[r.mongoName]) {
        state.verified[r.mongoName] = true;
        dirty = true;
      }
    } else {
      if (state.verified[r.mongoName]) {
        delete state.verified[r.mongoName];
        dirty = true;
      }
    }
  }
  if (dirty) await saveState(state);

  if (!allOk) {
    const failed = results.filter((r) => !r.countMatch || r.checksumMatch === false);
    console.error(`\nverify FAILED: ${failed.length} collection(s) mismatched`);
    process.exit(1);
  }
  console.log(`\nverify OK: ${results.length} collection(s) match`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error((err as Error).message);
    printUsage();
    process.exit(2);
  }

  if (!['pg-to-mongo', 'mongo-to-pg', 'verify'].includes(args.command)) {
    console.error(`cutover: unknown command "${args.command}"`);
    printUsage();
    process.exit(2);
  }

  const pg = await connectPg();
  const mongo = await connectMongo();
  try {
    if (args.dryRun) {
      if (args.command === 'verify') {
        throw new Error('cutover: --dry-run does not apply to verify');
      }
      await dryRunReport(
        pg,
        mongo,
        args.command as 'pg-to-mongo' | 'mongo-to-pg',
        args.collection,
      );
      return;
    }

    if (args.command === 'pg-to-mongo') await cmdPgToMongo(pg, mongo, args);
    else if (args.command === 'mongo-to-pg') await cmdMongoToPg(pg, mongo, args);
    else await cmdVerify(pg, mongo, args);
  } finally {
    await pg.close();
    await mongo.close();
  }
}

main().catch((err) => {
  console.error(`cutover: fatal: ${(err as Error).message}`);
  process.exit(1);
});
