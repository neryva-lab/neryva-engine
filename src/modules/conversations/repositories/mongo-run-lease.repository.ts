/**
 * MongoDB lane for `IRunLeaseRepository` (P3) — run fencing
 * (`McpAuthorityService` lease operations, §5.4).
 *
 * Behavioral truth: `src/modules/conversations/mcp-authority.service.ts`
 * (`acquireOrRenewRunLease` / `releaseRunLease`). Each method is one `withOrg`
 * unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` (plan D6).
 *
 * The acquire/renew CAS requires the caller's epoch to match and the owner
 * to be null or the expected owner. `runs.version` is deliberately NOT
 * bumped by lease operations — the epoch increment is the fencing counter.
 */
import type { Filter } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { ApiError } from '../../../common/http/api-error';
import { isTerminalRun } from '../state-machine';
import type { Run } from '../schema';
import type { IRunLeaseRepository } from './run-lease.repository';
import {
  requireOrg,
  tenantCollection,
  toRun,
  type RunMongoDoc,
} from './mongo-documents';

export class MongoRunLeaseRepository implements IRunLeaseRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async acquireOrRenewRunLease(input: {
    orgId: string;
    runId: string;
    callerScope: string;
    expectedOwner: string | null;
    expectedEpoch: number;
    renewUntil: Date;
  }): Promise<{ run: Run; acquired: boolean; leaseEpoch: number }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const runs = tenantCollection<RunMongoDoc>(db, 'runs');

      const runIdBin = uuidToBinary(input.runId);
      const found = await runs.findOne(orgId, { id: runIdBin }, sessionOpt);
      if (!found) {
        throw ApiError.notFound('run');
      }
      if (isTerminalRun(found.state)) {
        throw ApiError.conflict('run is terminal; lease cannot be acquired', { state: found.state });
      }

      // CAS: caller's epoch must match; first acquire matches the NULL owner.
      // Single findOneAndUpdate — the filter is the fence; a lost race
      // surfaces as a stale-epoch conflict, never a silent overwrite.
      const casFilter: Filter<RunMongoDoc> = {
        id: runIdBin,
        lease_epoch: input.expectedEpoch,
        $or: [{ lease_owner: null }, { lease_owner: input.expectedOwner }],
      };
      const now = new Date().toISOString();
      const updated = await runs.findOneAndUpdate(
        orgId,
        casFilter,
        {
          // Lease state is FENCING, not business state — `version` (the
          // expected_version CAS domain) is deliberately NOT bumped here;
          // the epoch increment is the fencing counter.
          $set: {
            lease_owner: input.callerScope,
            lease_expires_at: input.renewUntil.toISOString(),
            heartbeat_at: now,
            updated_at: now,
          },
          $inc: { lease_epoch: 1 },
        },
        { ...sessionOpt, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.conflict('stale lease epoch', {
          expected_epoch: input.expectedEpoch,
          actual_epoch: found.lease_epoch,
          lease_owner: found.lease_owner ?? null,
        });
      }
      return {
        run: toRun(updated),
        acquired: found.lease_owner === null,
        leaseEpoch: updated.lease_epoch,
      };
    });
  }

  /** Release CAS on the exact epoch. */
  async releaseRunLease(input: {
    orgId: string;
    runId: string;
    leaseEpoch: number;
  }): Promise<Run> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const runs = tenantCollection<RunMongoDoc>(db, 'runs');

      const runIdBin = uuidToBinary(input.runId);
      const found = await runs.findOne(orgId, { id: runIdBin }, sessionOpt);
      if (!found) {
        throw ApiError.notFound('run');
      }
      const updated = await runs.findOneAndUpdate(
        orgId,
        { id: runIdBin, lease_epoch: input.leaseEpoch },
        {
          $set: {
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
            updated_at: new Date().toISOString(),
          },
        },
        { ...sessionOpt, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.conflict('stale lease epoch on release', {
          expected: input.leaseEpoch,
          actual: found.lease_epoch,
        });
      }
      return toRun(updated);
    });
  }
}
