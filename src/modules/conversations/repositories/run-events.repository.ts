/**
 * Run-events repository (P3) — the persistence port for the run event log
 * (`McpAuthorityService` AppendRunEvents, §5.6).
 *
 * `appendRunEvents` owns its transaction: request-level idempotency
 * (run_idempotency claim inside the unit) plus per-event (run_id, event_id)
 * dedup echoing the original engine sequence. Rejects on terminal runs and
 * stale versions/epochs.
 */
import type { RunEvent } from '../schema';

export interface IRunEventsRepository {
  appendRunEvents(input: {
    orgId: string;
    runId: string;
    producerIdentity: string;
    events: Array<{
      eventId: string;
      eventType: string;
      schemaVersion: number;
      producerSequence?: number;
      payload: { case: string; value: unknown } | null;
      artifactId?: string;
    }>;
    expectedRunVersion?: number;
    idempotency?: { callerScope: string; idempotencyKey: string; requestHash: string };
    leaseEpoch?: number;
  }): Promise<{
    accepted: Array<{ eventId: string; engineSequence: number; duplicate: boolean }>;
    duplicateCount: number;
  }>;

  listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<RunEvent[]>;
}
