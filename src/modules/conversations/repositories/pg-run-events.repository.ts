/**
 * PostgreSQL run-events repository (P3) — the run event log (ledger 5.6).
 * Mechanical move of the `McpAuthorityService` AppendRunEvents unit.
 *
 * Owns its transaction: request-level idempotency (run_idempotency claim
 * inside the unit) plus per-event (run_id, event_id) dedup echoing the
 * original engine sequence. Rejects on terminal runs and stale
 * versions/epochs.
 */
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { runEvents, runs, type Run, type RunEvent } from '../schema';
import { runIdempotency } from '../mcp.schema';
import { isTerminalRun } from '../state-machine';
import type { IRunEventsRepository } from './run-events.repository';

export class PgRunEventsRepository implements IRunEventsRepository {
  constructor(private readonly db: DbService) {}

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
    expectedRunVersion?: number;
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
        throw ApiError.conflict('run is terminal; events rejected', { state: run.state });
      }
      this.assertLeaseFencing(run, input.leaseEpoch);
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
        const claim = await this.claimRunIdempotency(tx, {
          orgId: input.orgId,
          runId: input.runId,
          callerScope: input.idempotency.callerScope,
          idempotencyKey: input.idempotency.idempotencyKey,
          requestHash: input.idempotency.requestHash,
        });
        if (claim === 'duplicate') {
          // Exact retry of an already-applied batch: echo the stored rows.
          const stored = await tx
            .select({ eventId: runEvents.eventId, engineSequence: runEvents.engineSequence })
            .from(runEvents)
            .where(
              and(
                eq(runEvents.runId, input.runId),
                inArray(
                  runEvents.eventId,
                  input.events.map((e) => e.eventId),
                ),
              ),
            );
          const seqById = new Map(stored.map((s) => [s.eventId, s.engineSequence]));
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
        const inserted = await tx
          .insert(runEvents)
          .values({
            id: uuidv7(),
            eventId: event.eventId,
            runId: input.runId,
            organizationId: input.orgId,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            producerIdentity: input.producerIdentity,
            producerSequence: event.producerSequence ?? null,
            payload: event.payload as never,
            artifactId: event.artifactId ?? null,
          })
          .onConflictDoNothing({ target: [runEvents.runId, runEvents.eventId] })
          .returning({ engineSequence: runEvents.engineSequence });
        if (inserted.length === 0) {
          // (run_id, event_id) already exists — echo the ORIGINAL engine
          // sequence so the response reflects stored reality, not a
          // fabricated zero. The same event_id on a DIFFERENT run is a
          // separate row, never swallowed.
          duplicateCount += 1;
          const existing = await tx
            .select({ engineSequence: runEvents.engineSequence })
            .from(runEvents)
            .where(and(eq(runEvents.runId, input.runId), eq(runEvents.eventId, event.eventId)))
            .limit(1);
          accepted.push({
            eventId: event.eventId,
            engineSequence: existing[0]?.engineSequence ?? 0,
            duplicate: true,
          });
          continue;
        }
        accepted.push({
          eventId: event.eventId,
          engineSequence: inserted[0].engineSequence,
          duplicate: false,
        });
      }

      if (accepted.some((a) => !a.duplicate)) {
        const maxSeq = Math.max(
          ...accepted.filter((a) => !a.duplicate).map((a) => a.engineSequence),
        );
        await tx
          .update(runs)
          .set({
            lastEventSequence: Math.max(run.lastEventSequence, maxSeq),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(runs.id, input.runId));
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
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.engineSequence, after)))
        .orderBy(asc(runEvents.engineSequence))
        .limit(limit),
    );
  }

  /**
   * Lease-epoch fencing (ledger 5.11). Moved from `McpAuthorityService`;
   * the lease repository carries the canonical helper — this file keeps a
   * private copy so the events repository stays decoupled.
   */
  private assertLeaseFencing(run: Run, claimsLeaseEpoch?: number): void {
    if (claimsLeaseEpoch !== undefined && claimsLeaseEpoch !== run.leaseEpoch) {
      throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
        token_epoch: claimsLeaseEpoch,
        run_epoch: run.leaseEpoch,
      });
    }
  }

  /**
   * Run idempotency anchor (moved from `McpAuthorityService`): same caller
   * key + same digest → claimed; same key + different digest → conflict.
   */
  private async claimRunIdempotency(
    tx: NodePgDatabase,
    input: {
      orgId: string;
      runId: string;
      callerScope: string;
      idempotencyKey: string;
      requestHash: string;
    },
  ): Promise<'claimed' | 'duplicate'> {
    const inserted = await tx
      .insert(runIdempotency)
      .values({
        id: uuidv7(),
        organizationId: input.orgId,
        runId: input.runId,
        callerScope: input.callerScope,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: runIdempotency.id });
    if (inserted.length > 0) {
      return 'claimed';
    }
    const existing = await tx
      .select({ requestHash: runIdempotency.requestHash })
      .from(runIdempotency)
      .where(
        and(
          eq(runIdempotency.organizationId, input.orgId),
          eq(runIdempotency.callerScope, input.callerScope),
          eq(runIdempotency.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing.length > 0 && existing[0].requestHash !== input.requestHash) {
      throw ApiError.conflict('idempotency key reuse with different payload');
    }
    return 'duplicate';
  }
}
