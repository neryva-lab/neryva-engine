/**
 * MongoDB migration registry (plan D9).
 *
 * Ordered list of MongoDB migrations. The migrator (`../mongo-migrator.ts`)
 * applies them in this order; each entry pairs the migration with its
 * tamper-evidence fingerprint (sha256 over the migration's canonical spec,
 * computed at module load — see `../migration-checksum.ts`).
 *
 * Rules (same discipline as `drizzle/`):
 * - append-only: new migrations go at the END, never in the middle;
 * - an applied migration is immutable — to change behavior, write a new one;
 * - versions are zero-padded (`'0001'`) and unique;
 * - tags follow the `eng-NNNN` convention mirroring drizzle headers.
 */
import type { MongoMigration } from '../mongo-migrator';
import {
  MIGRATION_0001_SOURCE_CHECKSUM,
  migration0001EngineCore,
} from './0001_engine_core';

/** One registry entry: the migration plus its content fingerprint. */
export interface RegisteredMongoMigration {
  readonly migration: MongoMigration;
  /** sha256 of the migration's canonical spec (fail-closed on tamper). */
  readonly sourceChecksum: string;
}

/** All MongoDB migrations, in application order. Append-only. */
export const MONGO_MIGRATION_REGISTRY: readonly RegisteredMongoMigration[] = [
  { migration: migration0001EngineCore, sourceChecksum: MIGRATION_0001_SOURCE_CHECKSUM },
];

export type { MongoMigration };
