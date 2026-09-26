/**
 * Run-terminal repository (P3) — the persistence port for the MCP-side run
 * terminal transition (`McpAuthorityService.failRun`, §5.11).
 *
 * `failRun` owns its transaction: CAS to FAILED + terminal event + durable
 * quota release + outbox, one TX. Idempotent replay when already FAILED.
 */
import type { Run } from '../schema';

export interface IRunTerminalRepository {
  /** Raw row read; the service handles tombstone/404 mapping. */
  getRun(orgId: string, runId: string): Promise<Run | null>;

  failRun(input: {
    orgId: string;
    runId: string;
    errorCode: string;
    errorMessage: string;
    expectedVersion?: number;
    leaseEpoch?: number;
  }): Promise<{ run: Run; flipped: boolean; releaseQuotaHold: boolean }>;
}
