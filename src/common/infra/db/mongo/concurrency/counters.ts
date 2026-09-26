import type { ClientSession, Db, UpdateFilter } from 'mongodb';

/**
 * Atomic counters replacing PostgreSQL sequences and `max()+1` allocation.
 *
 * Call sites on the PostgreSQL lane (see plan D7):
 * - `run_events.engine_sequence bigserial` — DB-generated global ordering.
 * - `nextMessageSequence` — `select coalesce(max(sequence),0)+1 … where
 *   conversation_id = …` serialized by the conversation `FOR UPDATE` lock.
 *
 * A counter document `{ _id, seq }` with an atomic `$inc` via
 * `findOneAndUpdate` is strictly stronger than both: no lock needed, no
 * gaps from rollbacks are introduced by the counter itself, and concurrent
 * callers can never observe the same value.
 *
 * Key naming convention: `conversation:{id}:message_seq`,
 * `run_events:engine_sequence`, … — one counter per sequence domain.
 */

/** Collection holding all counter documents. `_id` is the counter key. */
export const COUNTERS_COLLECTION = 'mongo_counters';

interface CounterDoc {
  _id: string;
  seq: number;
}

export interface NextSequenceOptions {
  /** Optional session to run the increment under (e.g. inside a TX). */
  session?: ClientSession;
  /**
   * Value the FIRST call for a new key yields. Subsequent calls increment
   * from there. Implemented as `$setOnInsert: { seq: startAt - 1 }` combined
   * with `$inc: { seq: 1 }`, so a fresh counter yields exactly `startAt`.
   * Omit for the default sequence starting at 1.
   */
  startAt?: number;
}

/**
 * Atomically allocate the next value of the named sequence.
 * Monotonic per key; concurrent callers never receive the same value.
 */
export async function nextSequence(
  db: Db,
  key: string,
  opts: NextSequenceOptions = {},
): Promise<number> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('nextSequence: key must be a non-empty string');
  }
  const { session, startAt } = opts;
  if (startAt !== undefined && !Number.isInteger(startAt)) {
    throw new Error('nextSequence: startAt must be an integer');
  }

  const update: UpdateFilter<CounterDoc> =
    startAt === undefined
      ? { $inc: { seq: 1 } }
      : { $inc: { seq: 1 }, $setOnInsert: { seq: startAt - 1 } };

  const doc = await db
    .collection<CounterDoc>(COUNTERS_COLLECTION)
    .findOneAndUpdate({ _id: key }, update, {
      upsert: true,
      returnDocument: 'after',
      session,
    });

  // Unreachable with upsert:true + returnDocument:'after', but fail closed
  // rather than returning undefined into a sequence number.
  if (!doc || typeof doc.seq !== 'number') {
    throw new Error(`nextSequence: counter "${key}" returned no document`);
  }
  return doc.seq;
}
