import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { metrics } from '../../observability/metrics';
import { outboxEvents, type OutboxEvent } from './schema';
import { claimInbox, completeInbox, failInbox, PermanentConsumerError, type OutboxConsumer } from './consumer';

/**
 * Transactional outbox dispatcher — Phase 6.3 (ledger). PostgreSQL polling
 * with `FOR UPDATE SKIP LOCKED`; NATS/Debezium stay behind measurement
 * (ledger 11.1). The pinned state machine:
 *   PENDING -> CLAIMED -> PUBLISHED
 *                   |          ^-- all consumers done (or none registered)
 *                   +-> RETRY_WAIT (retryable failure, exp backoff + jitter)
 *                   +-> DEAD_LETTER (attempt threshold)
 * A CLAIMED row whose worker crashed is recovered to PENDING after the
 * reclaim timeout (claimed_at, drizzle/0025_outbox_dispatch.sql).
 *
 * Consumers are in-process (single monolith, ADR-001): the publisher fans an
 * event out to every registered consumer, each deduplicating through
 * `inbox_events` BEFORE its side effect (ledger 6.4). Cross-replica fan-out
 * arrives with the broker decision (6.5) — the event_id key and inbox
 * contract do not change.
 */

export const DISPATCH_METRICS = {
  published: metrics.counter('outbox_published_total', 'Outbox events published to all consumers', ['event_type']),
  retried: metrics.counter('outbox_retry_total', 'Outbox events moved to RETRY_WAIT', ['event_type']),
  deadLettered: metrics.counter('outbox_dead_letter_total', 'Outbox events moved to DEAD_LETTER', ['event_type']),
  recovered: metrics.counter('outbox_stale_claim_recovered_total', 'CLAIMED rows recovered after a worker crash', []),
  lag: metrics.gauge('outbox_age_seconds', 'Age of the oldest undispatched outbox event', [], collectOutboxAge),
};

function collectOutboxAge(): Array<{ labels: Record<string, string | number>; value: number }> {
  // Evaluated at scrape time by the gauge; set by the dispatcher tick.
  return [{ labels: {}, value: oldestPendingAgeSeconds }];
}

let oldestPendingAgeSeconds = 0;

/** Exponential backoff with full jitter, capped at 5 minutes. */
export function backoffMs(attempt: number, baseMs = 1_000, capMs = 300_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exp);
}

export interface DispatchResult {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
}

export class OutboxDispatcher {
  private static readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly db: DbService,
    private readonly consumers: OutboxConsumer[],
    private readonly opts?: { batchSize?: number; maxAttempts?: number; staleClaimMs?: number },
  ) {}

  private get batchSize(): number {
    return this.opts?.batchSize ?? 100;
  }

  private get maxAttempts(): number {
    return this.opts?.maxAttempts ?? 8;
  }

  private get staleClaimMs(): number {
    return this.opts?.staleClaimMs ?? 120_000;
  }

  /** One dispatch tick. Safe to run concurrently across replicas. */
  async tick(): Promise<DispatchResult> {
    const recovered = await this.recoverStaleClaims();
    const claimed = await this.claimBatch();
    const result: DispatchResult = { claimed: claimed.length, published: 0, retried: 0, deadLettered: 0 };

    for (const event of claimed) {
      const outcome = await this.publishOne(event);
      result[outcome] += 1;
    }
    if (recovered > 0) {
      DISPATCH_METRICS.recovered.inc({}, recovered);
    }
    return result;
  }

  /** Claim a bounded batch, oldest first (per-tenant fairness via FIFO). */
  private async claimBatch(): Promise<OutboxEvent[]> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            inArray(outboxEvents.status, ['PENDING', 'RETRY_WAIT']),
            lte(outboxEvents.nextAttemptAt, new Date().toISOString()),
          ),
        )
        .orderBy(asc(outboxEvents.createdAt))
        .limit(this.batchSize)
        .for('update', { skipLocked: true });

      if (rows.length === 0) {
        await this.updateOldestAge(tx);
        return [];
      }
      const ids = rows.map((r) => r.eventId);
      await tx
        .update(outboxEvents)
        .set({ status: 'CLAIMED', claimedAt: new Date().toISOString() })
        .where(inArray(outboxEvents.eventId, ids));
      return rows;
    });
  }

  /** Recover rows claimed by a crashed worker (claimed_at older than lease). */
  private async recoverStaleClaims(): Promise<number> {
    const cutoff = new Date(Date.now() - this.staleClaimMs).toISOString();
    return this.db.withBypass(async (tx) => {
      const recovered = await tx
        .update(outboxEvents)
        .set({ status: 'PENDING', claimedAt: null })
        .where(and(eq(outboxEvents.status, 'CLAIMED'), lte(outboxEvents.claimedAt, cutoff)))
        .returning({ id: outboxEvents.eventId });
      return recovered.length;
    });
  }

  private async updateOldestAge(tx: NodePgDatabase): Promise<void> {
    const res = await tx.execute(
      sql`select coalesce(extract(epoch from now() - min(created_at)), 0) as age
          from outbox_events where status in ('PENDING','RETRY_WAIT')`,
    );
    oldestPendingAgeSeconds = Number((res.rows[0] as { age: string | number })?.age ?? 0);
  }

  /** Fan out to consumers, each deduplicating through the inbox. */
  private async publishOne(event: OutboxEvent): Promise<'published' | 'retried' | 'deadLettered'> {
    const consumers = this.consumersFor(event.eventType);
    try {
      for (const consumer of consumers) {
        const claim = await claimInbox(this.db, consumer.name, event.eventId);
        if (claim === 'skip') {
          continue; // already durably processed for this consumer
        }
        try {
          await consumer.handle(event);
          await completeInbox(this.db, consumer.name, event.eventId, { event_type: event.eventType });
        } catch (err) {
          // Handler failure: release the inbox claim so redelivery can retry,
          // and classify the failure for the outbox retry machine.
          await failInbox(this.db, consumer.name, event.eventId, (err as Error).message);
          throw err;
        }
      }
      await this.markPublished(event.eventId);
      DISPATCH_METRICS.published.inc({ event_type: event.eventType });
      return 'published';
    } catch (err) {
      const message = (err as Error).message?.slice(0, 2000) ?? 'unknown dispatch error';
      // Permanent failures skip the retry budget — straight to dead-letter.
      const attempt = err instanceof PermanentConsumerError ? this.maxAttempts : event.attemptCount + 1;
      if (attempt >= this.maxAttempts) {
        await this.markDeadLetter(event.eventId, attempt, message);
        DISPATCH_METRICS.deadLettered.inc({ event_type: event.eventType });
        OutboxDispatcher.logger.error(`outbox event ${event.eventId} (${event.eventType}) dead-lettered after ${attempt} attempts: ${message}`);
        return 'deadLettered';
      }
      await this.markRetryWait(event.eventId, attempt, message);
      DISPATCH_METRICS.retried.inc({ event_type: event.eventType });
      return 'retried';
    }
  }

  private consumersFor(eventType: string): OutboxConsumer[] {
    return this.consumers.filter((c) => c.eventTypes.includes(eventType) || c.eventTypes.includes('*'));
  }

  private async markPublished(eventId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(outboxEvents)
        .set({ status: 'PUBLISHED', publishedAt: new Date().toISOString(), claimedAt: null, lastError: null })
        .where(eq(outboxEvents.eventId, eventId));
    });
  }

  private async markRetryWait(eventId: string, attempt: number, message: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(outboxEvents)
        .set({
          status: 'RETRY_WAIT',
          attemptCount: attempt,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempt)).toISOString(),
          claimedAt: null,
          lastError: message,
        })
        .where(eq(outboxEvents.eventId, eventId));
    });
  }

  private async markDeadLetter(eventId: string, attempt: number, message: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(outboxEvents)
        .set({ status: 'DEAD_LETTER', attemptCount: attempt, claimedAt: null, lastError: message })
        .where(eq(outboxEvents.eventId, eventId));
    });
  }

  /** Operator-authorized replay of a dead-lettered event (audited upstream). */
  async replayDeadLetter(eventId: string): Promise<boolean> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .update(outboxEvents)
        .set({ status: 'PENDING', attemptCount: 0, nextAttemptAt: new Date().toISOString(), claimedAt: null, lastError: null })
        .where(and(eq(outboxEvents.eventId, eventId), eq(outboxEvents.status, 'DEAD_LETTER')))
        .returning({ id: outboxEvents.eventId });
      return rows.length > 0;
    });
  }
}
