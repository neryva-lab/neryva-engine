/**
 * `IReconciliationRepository` — provider reconciliation + the billing
 * webhook inbox (P3, phases 8.7/8.8).
 *
 * Reconciliation compares the internal ledger against itself: negative
 * quantities outside compensations and unbalanced reversals become
 * `discrepant` rows + a reconciliation run record — never silent fixes.
 * The webhook inbox drives inbound provider events through the pinned
 * state machine received → signature_validated → deduplicated →
 * processed | rejected | reconciliation_required, keyed by
 * (provider, provider_event_id) for exactly-once handling.
 *
 * Transaction boundaries (each method owns its unit — no handles leak):
 *  - `runConsistencyPass` — one org transaction: insert the run row,
 *    flag negative non-compensating entries, flag unbalanced reversals,
 *    complete the run row with counts + findings.
 *  - `ingestWebhook` — one bypass transaction: insert-on-conflict, then
 *    reread on conflict. Duplicate (provider, provider_event_id) replays
 *    the recorded outcome (duplicate:true); the same provider event id
 *    with a DIFFERENT payload hash → typed conflict (a provider payload
 *    can never grant entitlement twice). Conflict on a row the reread
 *    cannot see → conflict (fail closed).
 *  - `markWebhookProcessed` / `markWebhookRequiresReconciliation` — one
 *    bypass transaction each, by inbox id.
 *
 * The inbox methods are deliberately bypass (not org scoped): the inbox is
 * a global provider-facing surface and the rows carry no org column,
 * matching the pre-P3 behavior.
 */
import type { BillingWebhookInboxRow } from '../usage-ledger.schema';

export interface IngestWebhookInput {
  provider: string;
  providerEventId: string;
  payloadHash: string;
  signatureResult: 'valid' | 'invalid';
  payloadRef?: Record<string, unknown>;
}

export interface IReconciliationRepository {
  /**
   * One consistency pass for an org. Returns the run id, the entries
   * checked, the discrepancy count, and the human-readable findings.
   */
  runConsistencyPass(
    orgId: string,
    provider: string,
  ): Promise<{ runId: string; checked: number; discrepancies: number; findings: string[] }>;

  /** Ingest a provider webhook (signature verified by the caller first). */
  ingestWebhook(input: IngestWebhookInput): Promise<{ row: BillingWebhookInboxRow; duplicate: boolean }>;

  markWebhookProcessed(id: string, processingResult: Record<string, unknown>): Promise<void>;

  markWebhookRequiresReconciliation(id: string, reason: string): Promise<void>;
}
