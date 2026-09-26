/**
 * PostgreSQL run-lease repository (P3) — run fencing (ledger 5.4).
 * Mechanical move of the `McpAuthorityService` lease operations.
 *
 * Fencing: lease state lives on the `runs` row (pinned decision); renew is a
 * CAS on lease_epoch — a stale epoch is rejected as ABORTED-equivalent.
 * Terminal states are immutable except via administrative reconciliation.
 */
import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { runs, type Run } from '../schema';
import { isTerminalRun } from '../state-machine';
import type { IRunLeaseRepository } from './run-lease.repository';

export class PgRunLeaseRepository implements IRunLeaseRepository {
  constructor(private readonly db: DbService) {}

  async acquireOrRenewRunLease(input: {
    orgId: string;
    runId: string;
    callerScope: string;
    expectedOwner: string | null;
    expectedEpoch: number;
    renewUntil: Date;
  }): Promise<{ run: Run; acquired: boolean; leaseEpoch: number }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; lease cannot be acquired', { state: run.state });
      }
      // CAS: caller's epoch must match; first acquire matches the NULL owner.
      const epochMatches = run.leaseEpoch === input.expectedEpoch;
      const ownerMatches = run.leaseOwner === null || run.leaseOwner === input.expectedOwner;
      if (!epochMatches || !ownerMatches) {
        throw ApiError.conflict('stale lease epoch', {
          expected_epoch: input.expectedEpoch,
          actual_epoch: run.leaseEpoch,
          lease_owner: run.leaseOwner ?? null,
        });
      }
      const newEpoch = run.leaseEpoch + 1;
      // Lease state is FENCING, not business state — `runs.version` (the
      // expected_version CAS domain) is deliberately NOT bumped here; the
      // epoch increment is the fencing counter (state-machine.ts pinned note).
      const updated = await tx
        .update(runs)
        .set({
          leaseOwner: input.callerScope,
          leaseEpoch: newEpoch,
          leaseExpiresAt: input.renewUntil.toISOString(),
          heartbeatAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();
      return { run: updated[0], acquired: run.leaseOwner === null, leaseEpoch: newEpoch };
    });
  }

  async releaseRunLease(input: { orgId: string; runId: string; leaseEpoch: number }): Promise<Run> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.leaseEpoch !== input.leaseEpoch) {
        throw ApiError.conflict('stale lease epoch on release', {
          expected: input.leaseEpoch,
          actual: run.leaseEpoch,
        });
      }
      const updated = await tx
        .update(runs)
        .set({
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();
      return updated[0];
    });
  }

  /**
   * Lease-epoch fencing (ledger 5.11 "validates capability + lease epoch").
   * A token that CARRIES a lease_epoch claim must present the run's CURRENT
   * epoch — a deposed or expired holder is rejected with ABORTED-equivalent.
   * Tokens without the claim (dispatch-issued, pre-lease) are fenced by the
   * acquire/renew CAS + the expected_version CAS instead — the frozen
   * neryva.mcp.v1 contract has no lease-renewal re-mint field, so this is the
   * strongest enforcement the wire supports.
   *
   * Kept here as the fencing authority's canonical helper (moved from
   * `McpAuthorityService`); repositories that consume it
   * (run-terminal, run-events) carry their own private copy so the lease
   * repository keeps no public surface beyond the interface.
   */
  private assertLeaseFencing(run: Run, claimsLeaseEpoch?: number): void {
    if (claimsLeaseEpoch !== undefined && claimsLeaseEpoch !== run.leaseEpoch) {
      throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
        token_epoch: claimsLeaseEpoch,
        run_epoch: run.leaseEpoch,
      });
    }
  }
}
