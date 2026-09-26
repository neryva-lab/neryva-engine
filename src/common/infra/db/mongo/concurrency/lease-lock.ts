import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Db } from 'mongodb';
import { MongoServerError } from 'mongodb';

/**
 * Distributed lease replacing `pg_advisory_xact_lock`.
 *
 * Call sites on the PostgreSQL lane (see plan D7): the audit hash-chain
 * appender, three assistant-mutation serializers, the quota reservation path,
 * and config-publish. All of them need "exactly one holder at a time, for a
 * bounded duration" — which a lease document provides without any server-side
 * lock primitive.
 *
 * Mechanics:
 * - One document per lease key in `mongo_leases`: `{ _id, owner, expiresAt }`.
 * - Acquire = `insertOne`, or — on duplicate key — an atomic steal iff the
 *   existing lease has expired (`findOneAndUpdate` with an `expiresAt` filter,
 *   so concurrent stealers cannot both win).
 * - Release = `deleteOne({ _id, owner })`: a holder can never release a lease
 *   it does not own (e.g. after its own lease expired and was stolen).
 * - A TTL index on `expiresAt` reaps dead leases; it is hygiene only — the
 *   steal logic compares `expiresAt` directly, because the TTL monitor runs
 *   roughly every 60s and must not be on the correctness path.
 *
 * The lease is NOT transactional: pass a `session` only to bind the acquire
 * to an ambient session for causal consistency, never to hold the lease for
 * a transaction's lifetime (a transaction-scoped advisory lock maps to
 * "acquire before the TX, release after commit", owned by the caller).
 */

/** Collection holding all lease documents. `_id` is the lease key. */
export const LEASES_COLLECTION = 'mongo_leases';

interface LeaseDoc {
  _id: string;
  owner: string;
  expiresAt: Date;
}

export interface AcquireLeaseOptions {
  /** Optional session to run the acquire under (causal consistency only). */
  session?: ClientSession;
  /** How long to keep trying before giving up. Default 10_000. `0` = try once. */
  timeoutMs?: number;
  /** Delay between attempts. Default 50. */
  retryMs?: number;
}

export interface LeaseHandle {
  /** Best-effort, idempotent: deletes the lease only if this handle still owns it. */
  release(): Promise<void>;
}

export class LeaseAcquisitionError extends Error {
  constructor(
    public readonly key: string,
    public readonly timeoutMs: number,
  ) {
    super(`failed to acquire lease "${key}" within ${timeoutMs}ms`);
    this.name = 'LeaseAcquisitionError';
  }
}

/** Create the TTL index on `expiresAt`. Idempotent — safe to call at boot. */
export async function ensureLeaseIndexes(db: Db): Promise<void> {
  await db
    .collection<LeaseDoc>(LEASES_COLLECTION)
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof MongoServerError) {
    return err.code === 11000;
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireLease(
  db: Db,
  key: string,
  ttlMs: number,
  opts: AcquireLeaseOptions = {},
): Promise<LeaseHandle> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('acquireLease: key must be a non-empty string');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('acquireLease: ttlMs must be a positive number');
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryMs = opts.retryMs ?? 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('acquireLease: timeoutMs must be >= 0');
  }
  if (!Number.isFinite(retryMs) || retryMs < 0) {
    throw new Error('acquireLease: retryMs must be >= 0');
  }

  const col: Collection<LeaseDoc> = db.collection<LeaseDoc>(LEASES_COLLECTION);
  const owner = randomUUID();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    try {
      await col.insertOne({ _id: key, owner, expiresAt }, { session: opts.session });
      return makeHandle(col, key, owner);
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }
      // Another holder exists — steal it atomically iff it has expired.
      // The filter makes concurrent stealers mutually exclusive.
      const stolen = await col.findOneAndUpdate(
        { _id: key, expiresAt: { $lte: now } },
        { $set: { owner, expiresAt } },
        { returnDocument: 'after', session: opts.session },
      );
      if (stolen) {
        return makeHandle(col, key, owner);
      }
      // Lost the race (or the lease is still live) — retry until the deadline.
    }

    if (Date.now() >= deadline) {
      throw new LeaseAcquisitionError(key, timeoutMs);
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(retryMs, Math.max(remaining, 0)));
  }
}

function makeHandle(
  col: Collection<LeaseDoc>,
  key: string,
  owner: string,
): LeaseHandle {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      // Owner-scoped: never releases a lease stolen by someone else after
      // this handle's own lease expired. No-op if already gone.
      await col.deleteOne({ _id: key, owner });
    },
  };
}
