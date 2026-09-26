import type { ClientSession, TransactionOptions } from 'mongodb';
import { MongoServerError } from 'mongodb';

/**
 * Transaction retry wrapper for the MongoDB lane (plan D5).
 *
 * `ClientSession.withTransaction` does NOT retry the transaction body on
 * transient errors — the application must. This wrapper retries the whole
 * body when the driver labels the failure `TransientTransactionError` or
 * `UnknownTransactionCommitResult`, with exponential backoff + full jitter.
 * Non-transient errors (duplicate key, validation, write conflicts surfaced
 * as such) are thrown immediately — retrying those would be wrong.
 *
 * Callers' transaction bodies MUST be idempotent across retries (same rule
 * as the PostgreSQL lane's `withSerializable`).
 */
export interface TxRetryOptions {
  /** Max body attempts including the first (default 5). */
  maxAttempts?: number;
  /** Base backoff in ms (default 50); doubled per attempt, capped. */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 2000). */
  maxDelayMs?: number;
  /** Extra transaction options merged over the defaults. */
  transactionOptions?: TransactionOptions;
}

const TRANSIENT_LABELS = new Set(['TransientTransactionError', 'UnknownTransactionCommitResult']);

function hasTransientLabel(err: unknown): boolean {
  const labels =
    err instanceof MongoServerError
      ? err.errorLabels
      : (err as { errorLabels?: unknown } | null)?.errorLabels;
  return Array.isArray(labels) && labels.some((l) => typeof l === 'string' && TRANSIENT_LABELS.has(l));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInTransaction<T>(
  session: ClientSession,
  fn: () => Promise<T>,
  opts: TxRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 50;
  const maxDelayMs = opts.maxDelayMs ?? 2000;
  const transactionOptions: TransactionOptions = {
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority' },
    ...opts.transactionOptions,
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await session.withTransaction(fn, transactionOptions);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && hasTransientLabel(err)) {
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(backoff + Math.random() * backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
