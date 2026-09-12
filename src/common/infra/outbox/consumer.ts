import { and, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { inboxEvents } from './schema';
import type { OutboxEvent } from './schema';

/**
 * Consumer contract — Phase 6.4 (ledger). A consumer:
 *  1. is registered for explicit `event_types` ('*' = all),
 *  2. deduplicates through `inbox_events` BEFORE any side effect
 *     (the dispatcher performs the claim — the handler never runs twice
 *     for the same (consumer, event) unless the claim went stale),
 *  3. carries `organization_id` from the event and enforces the tenant
 *     scope on every query it issues,
 *  4. throws to signal failure — the dispatcher classifies retry vs
 *     dead-letter; handlers must therefore be idempotent.
 *
 * Delivery is AT LEAST ONCE. Exactly-once business effects come from the
 * inbox claim + domain uniqueness, never from the transport.
 */
export interface OutboxConsumer {
  /** Stable consumer name — the inbox dedup key's first half. */
  name: string;
  eventTypes: string[];
  handle(event: OutboxEvent): Promise<void>;
}

/**
 * Thrown for failures retrying cannot fix (malformed payload, vanished
 * aggregate). The dispatcher dead-letters these immediately instead of
 * burning the retry budget.
 */
export class PermanentConsumerError extends Error {}

/** Default staleness for a PROCESSING claim left by a crashed worker. */
export const INBOX_STALE_MS = 5 * 60_000;

/**
 * - `claimed` — this worker owns the claim and MUST run the side effect.
 * - `skip`    — durably PROCESSED already; safe to continue.
 * - `busy`    — a fresh PROCESSING claim from another (possibly crashed)
 *               worker; the side effect is NOT known to have run. The
 *               dispatcher must NOT publish past it — requeue instead.
 */
export type InboxClaim = 'claimed' | 'skip' | 'busy';

/**
 * Claim (consumer_name, event_id) for processing. A RECEIVED/FAILED row is
 * reclaimable; a fresh PROCESSING row is `busy` (another worker may hold it);
 * a stale PROCESSING row (crashed worker past the staleness window) is
 * reclaimable. PROCESSED rows skip forever.
 */
export async function claimInbox(
  db: DbService,
  consumerName: string,
  eventId: string,
  staleMs: number = INBOX_STALE_MS,
): Promise<InboxClaim> {
  return db.withBypass(async (tx) => {
    const inserted = await tx
      .insert(inboxEvents)
      .values({ consumerName, eventId, status: 'PROCESSING' })
      .onConflictDoNothing()
      .returning({ consumerName: inboxEvents.consumerName });
    if (inserted.length > 0) {
      return 'claimed';
    }
    const rows = await tx
      .select()
      .from(inboxEvents)
      .where(and(eq(inboxEvents.consumerName, consumerName), eq(inboxEvents.eventId, eventId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      // PK conflict reported but the row is invisible: bypass/scope race or
      // concurrent delete. Fail CLOSED — treating this as processed would
      // drop a never-delivered event.
      throw new Error(`inbox claim lost for (${consumerName}, ${eventId}) — row vanished between conflict and select`);
    }
    if (row.status === 'PROCESSED') {
      return 'skip';
    }
    const claimedAt = Date.parse(row.lastReceivedAt);
    const stale = Number.isNaN(claimedAt) || Date.now() - claimedAt > staleMs;
    if (row.status === 'PROCESSING' && !stale) {
      return 'busy';
    }
    await tx
      .update(inboxEvents)
      .set({ status: 'PROCESSING', lastReceivedAt: new Date().toISOString(), lastError: null })
      .where(and(eq(inboxEvents.consumerName, consumerName), eq(inboxEvents.eventId, eventId)));
    return 'claimed';
  });
}

export async function completeInbox(db: DbService, consumerName: string, eventId: string, resultRef: Record<string, unknown>): Promise<void> {
  await db.withBypass(async (tx) => {
    await tx
      .update(inboxEvents)
      .set({ status: 'PROCESSED', processedAt: new Date().toISOString(), resultRef })
      .where(and(eq(inboxEvents.consumerName, consumerName), eq(inboxEvents.eventId, eventId)));
  });
}

export async function failInbox(db: DbService, consumerName: string, eventId: string, error: string): Promise<void> {
  await db.withBypass(async (tx) => {
    await tx
      .update(inboxEvents)
      .set({ status: 'FAILED', lastError: error.slice(0, 4000) })
      .where(and(eq(inboxEvents.consumerName, consumerName), eq(inboxEvents.eventId, eventId)));
  });
}
