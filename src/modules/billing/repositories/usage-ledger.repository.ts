/**
 * `IUsageLedgerRepository` — the immutable usage ledger aggregate (P3).
 *
 * The ledger is append-only (invariant 9): corrections are compensating
 * entries linked by `reversal_of` — history is NEVER rewritten.
 *
 * Transaction boundaries (each method owns its unit — no handles leak):
 *  - `append` — one org transaction: insert-on-conflict, then reread on
 *    conflict. Same (org, usage_event_id) → ignored (returns existing,
 *    duplicate:true). Same idempotency key with a DIFFERENT payload →
 *    typed conflict. Conflict on a row the reread cannot see → conflict
 *    (fail closed).
 *  - `correct` — one org transaction: read the original, insert the
 *    compensating entry, mark the original `discrepant` (only from
 *    `pending` — a concurrent reconciliation pass wins the flag, not us).
 *
 * What stays OUT: caller-side idempotency-key generation, logging, and
 * audit (the service replays from inputs + results).
 */
import type { UsageLedgerEntry } from '../usage-ledger.schema';

export interface AppendLedgerInput {
  orgId: string;
  usageEventId: string;
  sourceType: string;
  sourceId?: string;
  runId?: string;
  messageId?: string;
  usageKind: string;
  unit: string;
  /** Normalized to 6dp before insert. */
  quantity: number;
  provider?: string;
  model?: string;
  estimatedCost?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CorrectLedgerInput {
  orgId: string;
  originalEntryId: string;
  reason: string;
  actor: string;
  quantityDelta?: number;
  /** Usually the negated original cost; null/omitted = quantity-only correction. */
  costDelta?: number | null;
}

export interface IUsageLedgerRepository {
  /**
   * Append one entry. Duplicate event → `{ entry: existing, duplicate: true }`;
   * idempotency-key reuse with a different payload → `conflict`. Throws
   * `not_found`... never: missing rows are inserts, not reads.
   */
  append(input: AppendLedgerInput): Promise<{ entry: UsageLedgerEntry; duplicate: boolean }>;

  /**
   * Compensating correction: a NEW entry with the delta quantity pointing
   * at the original via `reversal_of`. Throws `not_found` for a missing
   * original, `validation` for reversing a compensating entry, a zero
   * delta, or a non-finite cost.
   */
  correct(input: CorrectLedgerInput): Promise<UsageLedgerEntry>;

  /** Explainability trace (8.10): run → ledger entries, creation order. */
  listForRun(orgId: string, runId: string): Promise<UsageLedgerEntry[]>;

  /** Net consumed quantity for a dimension over the ledger. */
  netQuantity(orgId: string, usageKind: string, sinceIso?: string): Promise<number>;
}
