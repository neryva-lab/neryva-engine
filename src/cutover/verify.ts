/**
 * Cutover verification: per-collection row counts + SHA-256 checksums.
 *
 * For each collection:
 *  (a) count: pg `COUNT(*)` vs mongo `countDocuments()`
 *  (b) checksum: stream all rows on both sides in `id` order, normalize each
 *      row through `canonicalize()` (sorted keys, UUIDs as lowercase strings,
 *      dates as ISO, `_id` dropped), SHA-256 the concatenation.
 *
 * Both lanes go through the SAME canonicalization, so the digests are
 * comparable regardless of provider representation (BSON Binary vs uuid
 * string, ISO string vs Date).
 *
 * Exits non-zero with a per-collection failure table on any mismatch.
 */
import { createHash } from 'node:crypto';
import { canonicalize, pgRowToMongoDoc } from './mappers';
import type { CollectionMapping } from './registry';
import { CUTOVER_REGISTRY, getCollection } from './registry';
import type { PgHandle, MongoHandle } from './connections';
import { pgCount } from './connections';

export interface VerifyResult {
  mongoName: string;
  pgTable: string;
  pgCount: number;
  mongoCount: number;
  countMatch: boolean;
  checksumMatch: boolean | null; // null when counts differ (checksum skipped)
  pgChecksum: string | null;
  mongoChecksum: string | null;
  notes: string[];
}

interface VerifyOptions {
  batchSize: number;
  /** Skip collections already marked verified in the state file. */
  skipVerified: Set<string>;
  /** Only verify this collection (mongo name). */
  onlyCollection?: string;
}

/** Stream all pg rows for a collection in pk order, paginated. */
async function* streamPgRows(
  pg: PgHandle,
  mapping: CollectionMapping,
  batchSize: number,
): AsyncGenerator<Record<string, unknown>, void, void> {
  let offset = 0;
  for (;;) {
    const rows = await pg.execute(
      `SELECT * FROM ${mapping.pgQuoted} ORDER BY ${mapping.pkColumn} LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );
    if (rows.length === 0) break;
    yield* rows;
    offset += rows.length;
    if (rows.length < batchSize) break;
  }
}

/** Stream all mongo docs for a collection in id order, paginated. */
async function* streamMongoDocs(
  mongo: MongoHandle,
  mapping: CollectionMapping,
  batchSize: number,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const coll = mongo.db.collection(mapping.mongoName);
  let lastId: unknown = null;
  for (;;) {
    const filter = lastId === null ? {} : { [mapping.pkColumn]: { $gt: lastId } };
    const docs = await coll
      .find(filter)
      .sort({ [mapping.pkColumn]: 1 })
      .limit(batchSize)
      .toArray();
    if (docs.length === 0) break;
    yield* docs as Record<string, unknown>[];
    lastId = (docs[docs.length - 1] as Record<string, unknown>)[mapping.pkColumn];
    if (docs.length < batchSize) break;
  }
}

/**
 * Checksum the pg lane: map each pg row → mongo doc shape, canonicalize,
 * hash the concatenation. This puts both lanes in the SAME representation
 * before hashing.
 */
async function checksumPgLane(
  pg: PgHandle,
  mapping: CollectionMapping,
  batchSize: number,
): Promise<{ digest: string; count: number; unknownColumns: Set<string> }> {
  const hash = createHash('sha256');
  let count = 0;
  const unknownColumns = new Set<string>();
  for await (const row of streamPgRows(pg, mapping, batchSize)) {
    const { doc, unknownColumns: unk } = pgRowToMongoDoc(row, mapping);
    for (const c of unk) unknownColumns.add(c);
    hash.update(JSON.stringify(canonicalize(doc)));
    hash.update('\n');
    count++;
  }
  return { digest: hash.digest('hex'), count, unknownColumns };
}

/** Checksum the mongo lane: canonicalize each doc directly. */
async function checksumMongoLane(
  mongo: MongoHandle,
  mapping: CollectionMapping,
  batchSize: number,
): Promise<{ digest: string; count: number }> {
  const hash = createHash('sha256');
  let count = 0;
  for await (const doc of streamMongoDocs(mongo, mapping, batchSize)) {
    hash.update(JSON.stringify(canonicalize(doc)));
    hash.update('\n');
    count++;
  }
  return { digest: hash.digest('hex'), count };
}

/** Verify one collection. */
export async function verifyCollection(
  pg: PgHandle,
  mongo: MongoHandle,
  mapping: CollectionMapping,
  batchSize: number,
): Promise<VerifyResult> {
  const notes: string[] = [];
  const pgN = await pgCount(pg, mapping.pgQuoted);
  const mongoN = await mongo.db.collection(mapping.mongoName).countDocuments();
  const countMatch = pgN === mongoN;

  let checksumMatch: boolean | null = null;
  let pgChecksum: string | null = null;
  let mongoChecksum: string | null = null;

  if (countMatch) {
    const pgRes = await checksumPgLane(pg, mapping, batchSize);
    const mongoRes = await checksumMongoLane(mongo, mapping, batchSize);
    pgChecksum = pgRes.digest;
    mongoChecksum = mongoRes.digest;
    checksumMatch = pgChecksum === mongoChecksum;
    if (pgRes.unknownColumns.size > 0) {
      notes.push(`pg columns without drizzle type info: ${[...pgRes.unknownColumns].join(', ')}`);
    }
    if (pgRes.count !== pgN) {
      notes.push(`pg stream count ${pgRes.count} != COUNT(*) ${pgN} (concurrent write?)`);
    }
  } else {
    notes.push('checksum skipped: counts differ');
  }

  return {
    mongoName: mapping.mongoName,
    pgTable: mapping.pgTable,
    pgCount: pgN,
    mongoCount: mongoN,
    countMatch,
    checksumMatch,
    pgChecksum,
    mongoChecksum,
    notes,
  };
}

/** Verify all (or one) collections. */
export async function verifyAll(
  pg: PgHandle,
  mongo: MongoHandle,
  opts: VerifyOptions,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const mapping of CUTOVER_REGISTRY) {
    if (opts.onlyCollection && mapping.mongoName !== opts.onlyCollection) continue;
    if (opts.skipVerified.has(mapping.mongoName)) continue;
    results.push(await verifyCollection(pg, mongo, mapping, opts.batchSize));
  }
  return results;
}

/** Print the verification table. Returns true when everything passed. */
export function printVerifyTable(results: VerifyResult[]): boolean {
  const nameW = Math.max(10, ...results.map((r) => r.mongoName.length));
  console.log('');
  console.log(
    `${'collection'.padEnd(nameW)} | ${'pg'.padStart(8)} | ${'mongo'.padStart(8)} | count | checksum`,
  );
  console.log(`${'-'.repeat(nameW)}-+-${'-'.repeat(8)}-+-${'-'.repeat(8)}-+-------+---------`);

  let allOk = true;
  for (const r of results) {
    const countOk = r.countMatch ? 'OK  ' : 'FAIL';
    const sumOk =
      r.checksumMatch === null ? 'skip' : r.checksumMatch ? 'OK  ' : 'FAIL';
    if (!r.countMatch || r.checksumMatch === false) allOk = false;
    console.log(
      `${r.mongoName.padEnd(nameW)} | ${String(r.pgCount).padStart(8)} | ${String(r.mongoCount).padStart(8)} | ${countOk} | ${sumOk}`,
    );
    for (const n of r.notes) {
      console.log(`${' '.repeat(nameW)} | note: ${n}`);
    }
    if (r.checksumMatch === false) {
      console.log(`${' '.repeat(nameW)} | pg:    ${r.pgChecksum}`);
      console.log(`${' '.repeat(nameW)} | mongo: ${r.mongoChecksum}`);
    }
  }
  console.log('');
  return allOk;
}

/** Dry-run report: per-collection row counts source vs target, no writes. */
export async function dryRunReport(
  pg: PgHandle,
  mongo: MongoHandle,
  direction: 'pg-to-mongo' | 'mongo-to-pg',
  onlyCollection?: string,
): Promise<void> {
  const nameW = Math.max(10, ...CUTOVER_REGISTRY.map((c) => c.mongoName.length));
  console.log('');
  console.log(`dry-run: ${direction} (no writes)`);
  console.log(`${'collection'.padEnd(nameW)} | ${'pg rows'.padStart(8)} | ${'mongo docs'.padStart(10)}`);
  console.log(`${'-'.repeat(nameW)}-+-${'-'.repeat(8)}-+-${'-'.repeat(10)}`);
  for (const mapping of CUTOVER_REGISTRY) {
    if (onlyCollection && mapping.mongoName !== onlyCollection) continue;
    const pgN = await pgCount(pg, mapping.pgQuoted);
    const mongoN = await mongo.db.collection(mapping.mongoName).countDocuments();
    console.log(
      `${mapping.mongoName.padEnd(nameW)} | ${String(pgN).padStart(8)} | ${String(mongoN).padStart(10)}`,
    );
  }
  console.log('');
}

// Re-export for the CLI's reverse-direction checksum (mongo→pg verify uses
// the same canonicalization; no separate code path needed).
export { getCollection };
export type { VerifyOptions };
