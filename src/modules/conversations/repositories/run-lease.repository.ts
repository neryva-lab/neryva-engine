/**
 * Run-lease repository (P3) — the persistence port for run fencing
 * (`McpAuthorityService` lease operations, §5.4).
 *
 * The acquire/renew CAS requires the caller's epoch to match and the owner
 * to be null or the expected owner. `runs.version` is deliberately NOT
 * bumped by lease operations — the epoch increment is the fencing counter.
 */
import type { Run } from '../schema';

export interface IRunLeaseRepository {
  acquireOrRenewRunLease(input: {
    orgId: string;
    runId: string;
    callerScope: string;
    expectedOwner: string | null;
    expectedEpoch: number;
    renewUntil: Date;
  }): Promise<{ run: Run; acquired: boolean; leaseEpoch: number }>;

  /** Release CAS on the exact epoch. */
  releaseRunLease(input: {
    orgId: string;
    runId: string;
    leaseEpoch: number;
  }): Promise<Run>;
}
