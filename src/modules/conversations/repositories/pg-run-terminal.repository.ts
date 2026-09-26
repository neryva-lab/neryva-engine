/**
 * PostgreSQL run-terminal repository (P3) — the MCP-side run terminal
 * transition (`McpAuthorityService.failRun`, §5.11). Mechanical move.
 *
 * `failRun` owns its transaction: CAS to FAILED + terminal event + durable
 * quota release + outbox, one TX. Idempotent replay when already FAILED.
 *
 * The durable quota release (REL-4.4) rides the TX; the advisory Redis hold
 * release is the SERVICE's job — this repository reports `releaseQuotaHold`
 * (true only when this call flipped a standard run) so the service can
 * release it after commit without double-releasing on replays.
 */
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { runEvents, runs, type Run } from '../schema';
import { assertRunTransition, isRunState } from '../state-machine';
import type { IRunTerminalRepository } from './run-terminal.repository';

export class PgRunTerminalRepository implements IRunTerminalRepository {
  constructor(private readonly db: DbService) {}

  async getRun(orgId: string, runId: string): Promise<Run | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(runs).where(eq(runs.id, runId)).limit(1),
    );
    return rows[0] ?? null;
  }

  /** FailRun (5.11 analogue): CAS to FAILED + terminal event + outbox in one TX. */
  async failRun(input: {
    orgId: string;
    runId: string;
    errorCode: string;
    errorMessage: string;
    expectedVersion?: number;
    leaseEpoch?: number;
  }): Promise<{ run: Run; flipped: boolean; releaseQuotaHold: boolean }> {
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
      if (run.state === 'FAILED') {
        return { run, flipped: false, releaseQuotaHold: false }; // idempotent replay
      }
      this.assertLeaseFencing(run, input.leaseEpoch);
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

      const insertedEvent = await tx
        .insert(runEvents)
        .values(
          (() => {
            const rowId = uuidv7();
            return {
              id: rowId,
              eventId: rowId,
              runId: run.id,
              organizationId: input.orgId,
              eventType: 'run.failed',
              payload: {
                case: 'terminal',
                value: { code: input.errorCode, message: input.errorMessage },
              },
              producerIdentity: 'engine:mcp-authority',
            };
          })(),
        )
        .returning({ engineSequence: runEvents.engineSequence });

      const updated = await tx
        .update(runs)
        .set({
          state: 'FAILED',
          terminalReason: input.errorCode.slice(0, 64),
          finishedAt: new Date().toISOString(),
          lastEventSequence: Math.max(run.lastEventSequence, insertedEvent[0].engineSequence),
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();

      // REL-4.4 — a failed run releases its durable quota reservation in the
      // SAME transaction (the wall must not count a run that never ran).
      if (run.runKind === 'standard') {
        await tx.execute(sql`
          update quota_reservations
          set state = 'RELEASED', released_at = now()
          where run_id = ${run.id}::uuid and state = 'RESERVED'
        `);
      }

      await recordOutboxEvent(tx, {
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
      // W2.4 — the durable reservation released in-TX (REL-4.4); the advisory
      // Redis hold was never released here (proved by wave-4 failure injection:
      // the org events counter leaked +1 per FAILED run). The service releases
      // it after commit, only when this call flipped the run — replays must
      // not double-release. `releaseQuotaHold` carries that signal.
      const flippedRun = updated[0];
      return {
        run: flippedRun,
        flipped: true,
        releaseQuotaHold: flippedRun.runKind === 'standard',
      };
    });
  }

  /**
   * Lease-epoch fencing (ledger 5.11). Moved from `McpAuthorityService`;
   * the lease repository carries the canonical helper — this file keeps a
   * private copy so the terminal repository stays decoupled.
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
