/**
 * MongoDB migration ledger + runner (plan D9).
 *
 * RELEASE-JOB-ONLY SEMANTICS — read before calling:
 * `runMongoMigrations` must be invoked exactly once per database from the
 * release job (the same discipline as `drizzle-kit migrate` for the
 * PostgreSQL lane: `pnpm run migrate` is release-job-only, never per-replica).
 * It must NOT run per application replica / on process boot, because:
 * - concurrent DDL from N replicas (createCollection / createIndex storms)
 *   risks version skew and wedged deploys;
 * - a partially-rolled-out fleet could apply different migration sets to the
 *   same database;
 * - `collMod` validator convergence on a hot collection can block writers.
 * The runner is race-tolerant (unique `_id` + insert-if-absent; a duplicate-key
 * loser re-reads and verifies the winner's checksum), but tolerance is a
 * safety net, not a calling convention. One release job, one database.
 *
 * Ledger collection: `mongo_migrations`.
 * - `_id`: migration version string (e.g. `'0001'`) — uniqueness is the
 *   exactly-once mechanism.
 * - `tag`: human tag, `eng-NNNN` convention mirroring the drizzle headers.
 * - `appliedAt`: ISO-8601 UTC timestamp of application.
 * - `checksum`: sha256 over the migration's canonical spec (see
 *   `migration-checksum.ts`). On every run, an already-recorded migration's
 *   stored checksum is compared against the code's current fingerprint;
 *   mismatch throws `MigrationChecksumMismatchError` — fail-closed on
 *   tampering or on editing an already-applied migration. The fix is always
 *   a NEW migration, never editing the applied one.
 */
import type { ClientSession, Db } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { MONGO_MIGRATION_REGISTRY } from './mongo/index';

/** A single MongoDB migration. DDL only — never business logic. */
export interface MongoMigration {
  /** Ordering key, zero-padded (`'0001'`). Unique in the registry. */
  version: string;
  /** Human tag, `eng-NNNN` convention (mirrors drizzle `-- eng-NNNN` headers). */
  tag: string;
  /**
   * Apply the migration. Must be convergent (safe to re-run after an
   * interrupted attempt): create-if-absent, `collMod` to converge, and
   * idempotent index creation. `session` is accepted for interface symmetry
   * with transactional migrations; DDL is not transactional in MongoDB, so
   * migrations may ignore it.
   */
  up(db: Db, session?: ClientSession): Promise<void>;
}

/** Name of the migration ledger collection. */
export const MONGO_MIGRATIONS_COLLECTION = 'mongo_migrations';

interface MigrationLedgerDoc {
  /** Migration version — the exactly-once key. */
  _id: string;
  tag: string;
  /** ISO-8601 UTC timestamp of application. */
  appliedAt: string;
  /** sha256 of the migration's canonical spec at apply time. */
  checksum: string;
}

/**
 * Thrown when the ledger already records a version whose checksum differs
 * from the migration code now being run. This means the applied migration
 * was edited after application (or the database was tampered with). The
 * runner refuses to proceed: write a new migration instead.
 */
export class MigrationChecksumMismatchError extends Error {
  constructor(
    public readonly version: string,
    public readonly tag: string,
    public readonly storedChecksum: string,
    public readonly currentChecksum: string,
  ) {
    super(
      `refusing to run: migration ${version} (${tag}) was already applied with a different checksum ` +
        `(stored ${storedChecksum.slice(0, 12)}… != current ${currentChecksum.slice(0, 12)}…). ` +
        `applied migrations are immutable — write a new migration instead`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

function mismatchError(version: string, tag: string, stored: string | undefined, current: string): MigrationChecksumMismatchError {
  return new MigrationChecksumMismatchError(version, tag, stored ?? '<missing>', current);
}

/**
 * Apply all pending MongoDB migrations in registry order, exactly once.
 *
 * Release-job-only: see the header comment. Takes only the `Db` handle —
 * wiring (client lifecycle, provider selection) is the `MongoDbService`'s
 * job, not this module's.
 */
export async function runMongoMigrations(db: Db): Promise<void> {
  const existing = await db
    .listCollections({ name: MONGO_MIGRATIONS_COLLECTION }, { nameOnly: true })
    .toArray();
  if (existing.length === 0) {
    await db.createCollection(MONGO_MIGRATIONS_COLLECTION);
  }
  const ledger = db.collection<MigrationLedgerDoc>(MONGO_MIGRATIONS_COLLECTION);

  for (const { migration, sourceChecksum } of MONGO_MIGRATION_REGISTRY) {
    const recorded = await ledger.findOne({ _id: migration.version });
    if (recorded) {
      if (recorded.checksum !== sourceChecksum) {
        throw mismatchError(migration.version, migration.tag, recorded.checksum, sourceChecksum);
      }
      continue;
    }

    await migration.up(db);

    const doc: MigrationLedgerDoc = {
      _id: migration.version,
      tag: migration.tag,
      appliedAt: new Date().toISOString(),
      checksum: sourceChecksum,
    };
    try {
      await ledger.insertOne(doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        // Lost a race with another release job applying the same migration.
        // Exactly-once still holds via the unique _id: verify the winner
        // applied identical content, otherwise fail closed.
        const winner = await ledger.findOne({ _id: migration.version });
        if (!winner || winner.checksum !== sourceChecksum) {
          throw mismatchError(migration.version, migration.tag, winner?.checksum, sourceChecksum);
        }
        continue;
      }
      throw err;
    }
  }
}

/** One registered migration that the ledger does not fully account for. */
export interface PendingMongoMigration {
  version: string;
  tag: string;
  /** `not-applied`: absent from the ledger; `checksum-mismatch`: applied but the code changed since. */
  reason: 'not-applied' | 'checksum-mismatch';
}

/**
 * Read-only migration-gap probe for boot-time readiness.
 * Compares every registered migration against the `mongo_migrations`
 * ledger and returns the ones that are missing or whose checksum no
 * longer matches. Applies NOTHING — the release job owns application
 * (`runMongoMigrations`); this only reports so boot can fail closed on
 * an unmigrated database instead of serving traffic on a half-built
 * schema.
 */
export async function listPendingMongoMigrations(db: Db): Promise<PendingMongoMigration[]> {
  const existing = await db
    .listCollections({ name: MONGO_MIGRATIONS_COLLECTION }, { nameOnly: true })
    .toArray();
  const ledger = existing.length === 0 ? null : db.collection<MigrationLedgerDoc>(MONGO_MIGRATIONS_COLLECTION);
  const pending: PendingMongoMigration[] = [];
  for (const { migration, sourceChecksum } of MONGO_MIGRATION_REGISTRY) {
    const recorded = ledger ? await ledger.findOne({ _id: migration.version }) : null;
    if (!recorded) {
      pending.push({ version: migration.version, tag: migration.tag, reason: 'not-applied' });
    } else if (recorded.checksum !== sourceChecksum) {
      pending.push({ version: migration.version, tag: migration.tag, reason: 'checksum-mismatch' });
    }
  }
  return pending;
}
