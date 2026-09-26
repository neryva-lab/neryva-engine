/**
 * MongoDB lane for `IRunEventsRepository` (P3) — the run event log
 * (`McpAuthorityService` AppendRunEvents, §5.6).
 *
 * Behavioral truth: `src/modules/conversations/mcp-authority.service.ts`
 * (`appendRunEvents`, `claimRunIdempotency`, `listRunEvents`). Each method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` (plan D6).
 *
 * `appendRunEvents` owns its transaction: request-level idempotency (the
 * `run_idempotency` claim inside the unit) plus per-event (run_id, event_id)
 * dedup echoing the original engine sequence. Rejects on terminal runs and
 * stale versions/epochs with the service's `ApiError` codes.
 */
import type { Db } from 'mongodb';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { nextSequence } from '../../../common/infra/db/mongo/concurrency/counters';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { isTerminalRun } from '../state-machine';
import type { RunEvent } from '../schema';
import type { IRunEventsRepository } from './run-events.repository';
import {
  assertLeaseFencing,
  isDuplicateKey,
  requireOrg,
  tenantCollection,
  toRun,
  toRunEvent,
  type RunEventMongoDoc,
  type RunIdempotencyMongoDoc,
  type RunMongoDoc,
} from './mongo-documents';

export class MongoRunEventsRepository implements IRunEventsRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /**
   * Defensive index provisioning. The release migration
   * (`mongo/0001_engine_core.ts`) does NOT provision the pg-parity
   * `uq_run_idempotency_scope` unique index on
   * (organization_id, caller_scope, idempotency_key) that the claim's 11000
   * path depends on — this is the gap; until the migration owns it,
   * `createIndex` is idempotent, so calling this is safe anywhere (tests,
   * one-off scripts) without double-provisioning in production.
   */
  static async ensureIndexes(db: Db): Promise<void> {
    await db.collection('run_idempotency').createIndex(
      { organization_id: 1, caller_scope: 1, idempotency_key: 1 },
      { unique: true, name: 'uq_run_idempotency_scope' },
    );
  }

  private indexesEnsured = false;

  /**
   * Lazy index provisioning: the release migration does not own the
   * pg-parity unique index yet, and the 11000 claim-loss path depends on it.
   * `createIndex` is idempotent, so concurrent first calls are harmless.
   */
  private async ensureIndexesOnce(): Promise<void> {
    if (this.indexesEnsured) return;
    await MongoRunEventsRepository.ensureIndexes(this.mongo.root);
    this.indexesEnsured = true;
  }

  async appendRunEvents(input: {
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
    /** Batch-level CAS (proto expected_run_version) — re-checked under the row lock. */
    expectedRunVersion?: number;
    /** Required ctx.idempotency_key — deduped via run_idempotency before inserts (ledger 5.6). */
    idempotency?: { callerScope: string; idempotencyKey: string; requestHash: string };
    leaseEpoch?: number;
  }): Promise<{
    accepted: Array<{ eventId: string; engineSequence: number; duplicate: boolean }>;
    duplicateCount: number;
  }> {
    if (input.events.length === 0 || input.events.length > 32) {
      throw ApiError.validation({ events: 'batch must contain 1..32 events' });
    }
    for (const event of input.events) {
      if (
        typeof event.eventId !== 'string' ||
        event.eventId.length < 1 ||
        event.eventId.length > 64
      ) {
        throw ApiError.validation({ events: 'event_id must be 1..64 chars' });
      }
    }
    const db = this.mongo.root;
    await this.ensureIndexesOnce();
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
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is terminal; events rejected', { state: run.state });
      }
      assertLeaseFencing(run, input.leaseEpoch);
      if (input.expectedRunVersion !== undefined && input.expectedRunVersion !== run.version) {
        throw ApiError.conflict('stale run version for event batch', {
          expected: input.expectedRunVersion,
          actual: run.version,
        });
      }

      // Request-level idempotency BEFORE any insert: same key + same digest
      // replays, same key + different digest is a typed conflict (ledger 5.6
      // failure case; common.proto RequestContext.idempotency_key contract).
      if (input.idempotency) {
        const claim = await this.claimRunIdempotency(db, ctx, orgId, {
          orgId: input.orgId,
          runId: input.runId,
          callerScope: input.idempotency.callerScope,
          idempotencyKey: input.idempotency.idempotencyKey,
          requestHash: input.idempotency.requestHash,
        });
        if (claim === 'duplicate') {
          // Exact retry of an already-applied batch: echo the stored rows.
          const stored = await runEvents
            .find(
              orgId,
              { run_id: runIdBin, event_id: { $in: input.events.map((e) => e.eventId) } },
              sessionOpt,
            )
            .toArray();
          const seqById = new Map(stored.map((s) => [s.event_id, s.engine_sequence]));
          return {
            accepted: input.events.map((e) => ({
              eventId: e.eventId,
              engineSequence: seqById.get(e.eventId) ?? 0,
              duplicate: true,
            })),
            duplicateCount: input.events.length,
          };
        }
      }

      const accepted: Array<{ eventId: string; engineSequence: number; duplicate: boolean }> = [];
      let duplicateCount = 0;
      for (const event of input.events) {
        // Replaces the pg bigserial default. A burned value on the duplicate
        // path below is pg-identical: INSERT ... ON CONFLICT DO NOTHING also
        // consumes the sequence before the conflict check.
        const engineSequence = await nextSequence(db, 'run_events:engine_sequence', {
          session: ctx.session,
        });
        const rowId = uuidv7();
        try {
          await runEvents.insertOne(
            orgId,
            {
              id: uuidToBinary(rowId),
              organization_id: uuidToBinary(orgId),
              run_id: runIdBin,
              event_id: event.eventId,
              event_type: event.eventType,
              schema_version: event.schemaVersion,
              engine_sequence: engineSequence,
              causation_id: null,
              correlation_id: null,
              producer_identity: input.producerIdentity,
              producer_sequence: event.producerSequence ?? null,
              payload: event.payload,
              artifact_id: event.artifactId ? uuidToBinary(event.artifactId) : null,
              created_at: new Date().toISOString(),
            },
            sessionOpt,
          );
        } catch (err) {
          // The mongo form of pg's ON CONFLICT DO NOTHING on
          // uq_run_events_run_event_id (provisioned by the release migration).
          if (!isDuplicateKey(err)) {
            throw err;
          }
          // (run_id, event_id) already exists — echo the ORIGINAL engine
          // sequence so the response reflects stored reality, not a
          // fabricated zero. The same event_id on a DIFFERENT run is a
          // separate row, never swallowed.
          duplicateCount += 1;
          const existing = await runEvents.findOne(
            orgId,
            { run_id: runIdBin, event_id: event.eventId },
            sessionOpt,
          );
          accepted.push({
            eventId: event.eventId,
            engineSequence: existing?.engine_sequence ?? 0,
            duplicate: true,
          });
          continue;
        }
        accepted.push({
          eventId: event.eventId,
          engineSequence,
          duplicate: false,
        });
      }

      if (accepted.some((a) => !a.duplicate)) {
        const maxSeq = Math.max(
          ...accepted.filter((a) => !a.duplicate).map((a) => a.engineSequence),
        );
        await runs.updateOne(
          orgId,
          { id: runIdBin },
          {
            $set: {
              last_event_sequence: Math.max(run.lastEventSequence, maxSeq),
              updated_at: new Date().toISOString(),
            },
          },
          sessionOpt,
        );
      }
      return { accepted, duplicateCount };
    });
  }

  async listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<RunEvent[]> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 50), 100);
    const after = opts?.afterSequence ?? 0;
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const docs = await tenantCollection<RunEventMongoDoc>(db, 'run_events')
        .find(
          requireOrg(ctx),
          { run_id: uuidToBinary(runId), engine_sequence: { $gt: after } },
          { session: ctx.session, sort: { engine_sequence: 1 }, limit },
        )
        .toArray();
      return docs.map(toRunEvent);
    });
  }

  /**
   * `claimRunIdempotency` from mcp-authority.service.ts, ported 1:1: insert
   * wins the claim; a unique-index conflict means somebody owns this key —
   * same digest replays ('duplicate'), different digest is a typed 409.
   */
  private async claimRunIdempotency(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    input: {
      orgId: string;
      runId: string;
      callerScope: string;
      idempotencyKey: string;
      requestHash: string;
    },
  ): Promise<'claimed' | 'duplicate'> {
    const sessionOpt = { session: ctx.session };
    const col = tenantCollection<RunIdempotencyMongoDoc>(db, 'run_idempotency');
    const now = new Date();
    try {
      await col.insertOne(
        orgId,
        {
          id: uuidToBinary(uuidv7()),
          organization_id: uuidToBinary(orgId),
          run_id: uuidToBinary(input.runId),
          caller_scope: input.callerScope,
          idempotency_key: input.idempotencyKey,
          request_hash: input.requestHash,
          status: 'IN_PROGRESS',
          resource_ref: null,
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
        },
        sessionOpt,
      );
      return 'claimed';
    } catch (err) {
      // Unique-index conflict = somebody owns this key. 11000 is the
      // claim-loss signal (plan D7); anything else is a real failure.
      if (!isDuplicateKey(err)) {
        throw err;
      }
    }
    const existing = await col.findOne(
      orgId,
      { caller_scope: input.callerScope, idempotency_key: input.idempotencyKey },
      sessionOpt,
    );
    if (existing && existing.request_hash !== input.requestHash) {
      throw ApiError.conflict('idempotency key reuse with different payload');
    }
    return 'duplicate';
  }
}
