/**
 * MongoDB lane for `IRunTerminalRepository` (P3) — the MCP-side run terminal
 * transition (`McpAuthorityService.failRun`, §5.11).
 *
 * Behavioral truth: `src/modules/conversations/mcp-authority.service.ts`
 * (`failRun`). `failRun` owns its transaction: CAS to FAILED + terminal event
 * + durable quota release + outbox, one TX (invariant 7). Idempotent replay
 * when already FAILED.
 *
 * The advisory Redis hold release stays a service concern: the repository
 * reports `releaseQuotaHold` (true only when this call flipped a standard
 * run) and the service releases after commit — replays never double-release.
 */
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { nextSequence } from '../../../common/infra/db/mongo/concurrency/counters';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { assertRunTransition, isRunState } from '../state-machine';
import type { Run } from '../schema';
import type { IRunTerminalRepository } from './run-terminal.repository';
import {
  assertLeaseFencing,
  requireOrg,
  tenantCollection,
  toRun,
  type QuotaReservationMongoDoc,
  type RunEventMongoDoc,
  type RunMongoDoc,
} from './mongo-documents';

export class MongoRunTerminalRepository implements IRunTerminalRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /** Raw row read; the service handles tombstone/404 mapping. */
  async getRun(orgId: string, runId: string): Promise<Run | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const doc = await tenantCollection<RunMongoDoc>(db, 'runs').findOne(
        requireOrg(ctx),
        { id: uuidToBinary(runId) },
        { session: ctx.session },
      );
      return doc ? toRun(doc) : null;
    });
  }

  async failRun(input: {
    orgId: string;
    runId: string;
    errorCode: string;
    errorMessage: string;
    expectedVersion?: number;
    leaseEpoch?: number;
  }): Promise<{ run: Run; flipped: boolean; releaseQuotaHold: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const runs = tenantCollection<RunMongoDoc>(db, 'runs');
      const runEvents = tenantCollection<RunEventMongoDoc>(db, 'run_events');

      const runIdBin = uuidToBinary(input.runId);
      const found = await runs.findOne(orgId, { id: runIdBin }, sessionOpt);
      if (!found) {
        throw ApiError.notFound('run');
      }
      const run = toRun(found);
      if (run.state === 'FAILED') {
        return { run, flipped: false, releaseQuotaHold: false }; // idempotent replay
      }
      assertLeaseFencing(run, input.leaseEpoch);
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw ApiError.conflict('stale run version', {
          expected: input.expectedVersion,
          actual: run.version,
        });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'FAILED');

      const rowId = uuidv7();
      const now = new Date().toISOString();
      const engineSequence = await nextSequence(db, 'run_events:engine_sequence', {
        session: ctx.session,
      });
      await runEvents.insertOne(
        orgId,
        {
          id: uuidToBinary(rowId),
          organization_id: uuidToBinary(orgId),
          run_id: runIdBin,
          event_id: rowId,
          event_type: 'run.failed',
          schema_version: 1,
          engine_sequence: engineSequence,
          causation_id: null,
          correlation_id: null,
          producer_identity: 'engine:mcp-authority',
          producer_sequence: null,
          payload: {
            case: 'terminal',
            value: { code: input.errorCode, message: input.errorMessage },
          },
          artifact_id: null,
          created_at: now,
        },
        sessionOpt,
      );

      const updated = await runs.findOneAndUpdate(
        orgId,
        { id: runIdBin },
        {
          $set: {
            state: 'FAILED',
            terminal_reason: input.errorCode.slice(0, 64),
            finished_at: now,
            last_event_sequence: Math.max(run.lastEventSequence, engineSequence),
            version: run.version + 1,
            updated_at: now,
          },
        },
        { ...sessionOpt, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.internal();
      }

      // REL-4.4 — a failed run releases its durable quota reservation in the
      // SAME transaction (the wall must not count a run that never ran).
      if (run.runKind === 'standard') {
        await tenantCollection<QuotaReservationMongoDoc>(db, 'quota_reservations').updateMany(
          orgId,
          { run_id: runIdBin, state: 'RESERVED' },
          { $set: { state: 'RELEASED', released_at: now } },
          sessionOpt,
        );
      }

      const outbox = new MongoOutboxStore(db, ctx);
      await outbox.append({
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.failed',
        partitionKey: run.conversationId,
        payload: {
          run_id: run.id,
          conversation_id: run.conversationId,
          error_code: input.errorCode,
        },
      });

      const flippedRun = toRun(updated);
      return { run: flippedRun, flipped: true, releaseQuotaHold: run.runKind === 'standard' };
    });
  }
}
