import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document, Filter, WithId } from 'mongodb';
import { inboxEvents, outboxEvents, type InboxEvent, type OutboxEvent, type OutboxStatus } from '../../outbox/schema';
import { uuidv7 } from '../../../ids/uuidv7';
import { nowIso, uuidToBinary, type MongoTxContext } from '../mongo/mongo-tx';
import { PlatformCollection, TenantScopedCollection } from '../mongo/concurrency/tenant-guard';

/**
 * Outbox/Inbox port — P2 (plan §P2, D2/D7).
 *
 * Persistence seam for the transactional outbox (`outbox_events`) and the
 * consumer dedup ledger (`inbox_events`). Constructor binding: the store is
 * bound to its transaction/session at construction — no tx/session appears in
 * method signatures. The pg implementation is a mechanical move of the
 * existing Drizzle query logic in `src/common/infra/outbox/` (service,
 * dispatcher, consumer); the Mongo implementation is the native-driver
 * equivalent per plan D7.
 *
 * Semantics copied 1:1 from the PostgreSQL lane (see the "pg parity" notes
 * on each method):
 * - State machine: PENDING -> CLAIMED -> PUBLISHED, with CLAIMED -> RETRY_WAIT
 *   (retryable, backoff) and -> DEAD_LETTER (attempt threshold). Stale CLAIMED
 *   rows (crashed worker) recover to PENDING past the claim lease.
 * - Claim: WHERE status IN (PENDING, RETRY_WAIT) AND next_attempt_at <= now
 *   [AND event_type IN (claimable)] ORDER BY created_at, event_id LIMIT n,
 *   claimed atomically (pg: FOR UPDATE SKIP LOCKED; mongo: findOneAndUpdate).
 * - FIFO tie-break: created_at, then event_id (uuidv7, time-sortable).
 * - Inbox: (consumer_name, event_id) unique claim; PROCESSED skips forever;
 *   fresh PROCESSING is busy; stale PROCESSING is reclaimable; a PK conflict
 *   with an invisible row fails CLOSED (never treated as processed).
 *
 * Tenant scoping (plan D6):
 * - `outbox_events` is tenant-scoped (pg RLS FORCE on organization_id).
 *   `append` is always tenant-bound (ctx.orgId; throws in bypass mode).
 *   The dispatch-plane operations (claim/mark/recover) are keyed by event_id
 *   with NO org predicate — this mirrors the pg lane exactly, where the
 *   dispatcher runs them under `db.withBypass` (no tenant context). They go
 *   through `unsafeNative` with that rationale stated, not through silent
 *   unscoped access.
 * - `inbox_events` is platform-plane by schema design (no RLS, no tenant
 *   rows — see schema.ts docstring), so the inbox store uses
 *   PlatformCollection deliberately.
 */

// ─── Shared contract ─────────────────────────────────────────────────────────

/** Write-side event. Mirrors `OutboxEventInput` in outbox.service.ts. */
export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  eventType: string;
  eventVersion?: number;
  payload?: Record<string, unknown>;
  /** Ordering/fan-out key — per-aggregate (conversation_id/run_id), not global. */
  partitionKey: string;
  traceId?: string;
  correlationId?: string;
}

/**
 * Provider-neutral read model. Timestamps are canonical UTC ISO-8601 strings
 * (`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`); the pg lane already returns strings
 * (`timestamp(..., { mode: 'string' })`) and the mongo lane stores the
 * microsecond string as the authoritative ordering key (see below).
 */
export interface StoredEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown> | null;
  partitionKey: string;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: string;
  traceId: string | null;
  correlationId: string | null;
  createdAt: string;
  publishedAt: string | null;
  claimedAt: string | null;
  lastError: string | null;
}

export interface ClaimBatchOptions {
  /**
   * Restrict claims to these event types. Mirrors the dispatcher's
   * `claimableEventTypes()`: `undefined` = all types (wildcard dispatcher),
   * `[]` = claim nothing (fail closed — dispatcher with no consumers).
   */
  eventTypes?: string[];
  /** Claim-due horizon; default `new Date()`. */
  now?: Date;
}

export interface InboxKey {
  consumerName: string;
  eventId: string;
}

export interface IInboxStore {
  /**
   * Claim (consumer_name, event_id) for processing.
   * - `true` — this worker owns the claim and MUST run the side effect
   *   (fresh insert, or reclaim of a stale PROCESSING / RECEIVED / FAILED row).
   * - `false` — duplicate: PROCESSED already, or a fresh PROCESSING claim is
   *   held elsewhere (the pg lane's `busy` maps to `false` here).
   * A unique-key conflict with an invisible row throws (fail closed — the pg
   * lane's "claim lost" guard, consumer.ts).
   */
  tryClaim(key: InboxKey, opts?: { staleMs?: number }): Promise<boolean>;
  /** Mark durably processed (pg: completeInbox). */
  complete(key: InboxKey, resultRef?: Record<string, unknown>): Promise<void>;
  /** Mark failed; the row becomes reclaimable (pg: failInbox). */
  fail(key: InboxKey, error: string): Promise<void>;
}

export interface IOutboxStore {
  /** Insert a PENDING event. Must run in the same TX as the canonical fact (invariant 7). */
  append(input: OutboxEventInput): Promise<StoredEvent>;
  /**
   * Atomically claim up to `limit` due events, oldest first.
   * pg parity: FOR UPDATE SKIP LOCKED + UPDATE … SET CLAIMED — safe across
   * concurrent dispatchers. mongo parity: one atomic findOneAndUpdate per
   * claim (no SKIP LOCKED needed).
   */
  claimBatch(limit: number, opts?: ClaimBatchOptions): Promise<StoredEvent[]>;
  markPublished(eventId: string): Promise<void>;
  /**
   * Move to RETRY_WAIT with `nextAttemptAt = retryAt`, attempt_count + 1
   * (atomic increment). Returns the new attempt count so the caller can apply
   * the dead-letter threshold (pg: dispatcher.publishOne).
   */
  markFailed(eventId: string, error: string, retryAt: Date): Promise<number>;
  /**
   * Move to DEAD_LETTER. `attempt` overrides attempt_count when the caller
   * computed it (pg: PermanentConsumerError jumps straight to maxAttempts);
   * otherwise the count is left as-is.
   */
  moveToDeadLetter(eventId: string, error?: string, attempt?: number): Promise<void>;
  /**
   * Recover CLAIMED rows whose claim is older than `olderThanMs` back to
   * PENDING (pg: dispatcher.recoverStaleClaims, default lease 120s).
   * Returns the number of recovered rows.
   */
  recoverStaleClaims(olderThanMs: number): Promise<number>;
}

/** Default claim-lease staleness — mirrors `OutboxDispatcher`'s staleClaimMs (dispatcher.ts). */
export const DEFAULT_STALE_CLAIM_MS = 120_000;
/** Default inbox PROCESSING-claim staleness — mirrors `INBOX_STALE_MS` (consumer.ts). */
export const INBOX_STALE_MS = 5 * 60_000;

// ─── PostgreSQL implementation (mechanical move of src/common/infra/outbox/) ─

function toStoredEvent(row: OutboxEvent): StoredEvent {
  return {
    eventId: row.eventId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    organizationId: row.organizationId,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    partitionKey: row.partitionKey,
    status: row.status as OutboxStatus,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    traceId: row.traceId,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    claimedAt: row.claimedAt,
    lastError: row.lastError,
  };
}

/**
 * pg parity source: `recordOutboxEvent` (outbox.service.ts) + `OutboxDispatcher`
 * (dispatcher.ts: claimBatch, recoverStaleClaims, markPublished, markRetryWait,
 * markDeadLetter, requeueBusy).
 *
 * The caller supplies the Drizzle tx — `DbService.withOrg` for tenant writes
 * (RLS `app.current_tenant` applies), `DbService.withBypass` for the
 * dispatch-plane operations (RLS bypass, exactly as the dispatcher does).
 */
export class PgOutboxStore implements IOutboxStore {
  constructor(private readonly tx: NodePgDatabase) {}

  async append(input: OutboxEventInput): Promise<StoredEvent> {
    // pg parity: recordOutboxEvent — insert only; same-TX-as-fact is the caller's duty.
    const rows = await this.tx
      .insert(outboxEvents)
      .values({
        eventId: uuidv7(),
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        organizationId: input.organizationId,
        eventType: input.eventType,
        eventVersion: input.eventVersion ?? 1,
        payload: input.payload ?? null,
        partitionKey: input.partitionKey,
        status: 'PENDING',
        traceId: input.traceId ?? null,
        correlationId: input.correlationId ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('outbox append failed: no row returned');
    return toStoredEvent(row);
  }

  async claimBatch(limit: number, opts?: ClaimBatchOptions): Promise<StoredEvent[]> {
    // pg parity: OutboxDispatcher.claimBatch — status/next_attempt_at filter,
    // optional event-type scoping, FIFO (created_at, event_id), SKIP LOCKED,
    // then UPDATE … SET CLAIMED. Returned rows are the pre-claim snapshot,
    // exactly as the dispatcher sees them.
    const nowIso = (opts?.now ?? new Date()).toISOString();
    const filters = [inArray(outboxEvents.status, ['PENDING', 'RETRY_WAIT']), lte(outboxEvents.nextAttemptAt, nowIso)];
    if (opts?.eventTypes !== undefined) {
      filters.push(inArray(outboxEvents.eventType, opts.eventTypes));
    }
    const rows = await this.tx
      .select()
      .from(outboxEvents)
      .where(and(...filters))
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.eventId))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.eventId);
    await this.tx
      .update(outboxEvents)
      .set({ status: 'CLAIMED', claimedAt: new Date().toISOString() })
      .where(inArray(outboxEvents.eventId, ids));
    return rows.map(toStoredEvent);
  }

  async markPublished(eventId: string): Promise<void> {
    // pg parity: OutboxDispatcher.markPublished.
    await this.tx
      .update(outboxEvents)
      .set({ status: 'PUBLISHED', publishedAt: new Date().toISOString(), claimedAt: null, lastError: null })
      .where(eq(outboxEvents.eventId, eventId));
  }

  async markFailed(eventId: string, error: string, retryAt: Date): Promise<number> {
    // pg parity: OutboxDispatcher.markRetryWait — atomic attempt_count + 1,
    // RETRY_WAIT with the caller-computed next attempt (backoff lives with the
    // caller, as in the dispatcher). Returns the new attempt count.
    const rows = await this.tx
      .update(outboxEvents)
      .set({
        status: 'RETRY_WAIT',
        attemptCount: sql`${outboxEvents.attemptCount} + 1`,
        nextAttemptAt: retryAt.toISOString(),
        claimedAt: null,
        lastError: error.slice(0, 4000),
      })
      .where(eq(outboxEvents.eventId, eventId))
      .returning({ attemptCount: outboxEvents.attemptCount });
    const row = rows[0];
    if (!row) throw new Error(`outbox markFailed: unknown event ${eventId}`);
    return row.attemptCount;
  }

  async moveToDeadLetter(eventId: string, error?: string, attempt?: number): Promise<void> {
    // pg parity: OutboxDispatcher.markDeadLetter — DEAD_LETTER keeps the
    // (possibly jumped) attempt count; claimed_at cleared, error recorded.
    await this.tx
      .update(outboxEvents)
      .set({
        status: 'DEAD_LETTER',
        ...(attempt !== undefined ? { attemptCount: attempt } : {}),
        claimedAt: null,
        lastError: error?.slice(0, 4000) ?? null,
      })
      .where(eq(outboxEvents.eventId, eventId));
  }

  async recoverStaleClaims(olderThanMs: number): Promise<number> {
    // pg parity: OutboxDispatcher.recoverStaleClaims — CLAIMED older than the
    // lease goes back to PENDING with the claim cleared.
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const recovered = await this.tx
      .update(outboxEvents)
      .set({ status: 'PENDING', claimedAt: null })
      .where(and(eq(outboxEvents.status, 'CLAIMED'), lte(outboxEvents.claimedAt, cutoff)))
      .returning({ id: outboxEvents.eventId });
    return recovered.length;
  }
}

/**
 * pg parity source: `claimInbox` / `completeInbox` / `failInbox` (consumer.ts).
 * `inbox_events` is platform-plane (no RLS) — any tx works.
 */
export class PgInboxStore implements IInboxStore {
  constructor(private readonly tx: NodePgDatabase) {}

  async tryClaim(key: InboxKey, opts?: { staleMs?: number }): Promise<boolean> {
    // pg parity: claimInbox — insert-on-conflict-do-nothing; on conflict read
    // the row: PROCESSED => duplicate; fresh PROCESSING => busy (duplicate);
    // stale PROCESSING / RECEIVED / FAILED => reclaim; invisible row => throw.
    const inserted = await this.tx
      .insert(inboxEvents)
      .values({ consumerName: key.consumerName, eventId: key.eventId, status: 'PROCESSING' })
      .onConflictDoNothing()
      .returning({ consumerName: inboxEvents.consumerName });
    if (inserted.length > 0) return true;
    const rows = await this.tx
      .select()
      .from(inboxEvents)
      .where(and(eq(inboxEvents.consumerName, key.consumerName), eq(inboxEvents.eventId, key.eventId)))
      .limit(1);
    const row: InboxEvent | undefined = rows[0];
    if (!row) {
      throw new Error(`inbox claim lost for (${key.consumerName}, ${key.eventId}) — row vanished between conflict and select`);
    }
    if (row.status === 'PROCESSED') return false;
    const claimedAt = Date.parse(row.lastReceivedAt);
    const stale = Number.isNaN(claimedAt) || Date.now() - claimedAt > (opts?.staleMs ?? INBOX_STALE_MS);
    if (row.status === 'PROCESSING' && !stale) return false;
    await this.tx
      .update(inboxEvents)
      .set({ status: 'PROCESSING', lastReceivedAt: new Date().toISOString(), lastError: null })
      .where(and(eq(inboxEvents.consumerName, key.consumerName), eq(inboxEvents.eventId, key.eventId)));
    return true;
  }

  async complete(key: InboxKey, resultRef?: Record<string, unknown>): Promise<void> {
    // pg parity: completeInbox.
    await this.tx
      .update(inboxEvents)
      .set({ status: 'PROCESSED', processedAt: new Date().toISOString(), resultRef: resultRef ?? null })
      .where(and(eq(inboxEvents.consumerName, key.consumerName), eq(inboxEvents.eventId, key.eventId)));
  }

  async fail(key: InboxKey, error: string): Promise<void> {
    // pg parity: failInbox.
    await this.tx
      .update(inboxEvents)
      .set({ status: 'FAILED', lastError: error.slice(0, 4000) })
      .where(and(eq(inboxEvents.consumerName, key.consumerName), eq(inboxEvents.eventId, key.eventId)));
  }
}

// ─── MongoDB implementation (native driver, plan D3/D4/D7) ───────────────────

/**
 * `outbox_events` document — relational shape per plan D4: same snake_case
 * field names as the pg table, UUIDs as BSON binary subtype 4 (STANDARD).
 *
 * Timestamps: BSON Dates (`created_at`, `next_attempt_at`, `claimed_at`,
 * `published_at`) for queryability, PLUS the canonical microsecond UTC string
 * `created_at_us` as the authoritative FIFO ordering key. BSON Date is
 * millisecond-precision only, so sorting on the Date alone cannot reproduce
 * pg's microsecond-exact `(created_at, event_id)` FIFO; the µs string is
 * fixed-width and lexicographically chronological. (Same-ms ties still break
 * on `event_id` — uuidv7 is random within the millisecond in this codebase's
 * generator, which matches pg's behavior for same-transaction appends where
 * `now()` is identical for every row.)
 */
export interface OutboxDoc extends Document {
  event_id: Binary;
  aggregate_type: string;
  aggregate_id: Binary;
  organization_id: Binary;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown> | null;
  partition_key: string;
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: Date;
  trace_id: string | null;
  correlation_id: Binary | null;
  created_at: Date;
  created_at_us: string;
  published_at: Date | null;
  claimed_at: Date | null;
  last_error: string | null;
}

/** `inbox_events` document — platform-plane, mirrors the pg table 1:1. */
export interface InboxDoc extends Document {
  consumer_name: string;
  event_id: Binary;
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
  first_received_at: Date;
  last_received_at: Date;
  processed_at: Date | null;
  result_ref: Record<string, unknown> | null;
  last_error: string | null;
}

function mongoToStoredEvent(doc: WithId<OutboxDoc>): StoredEvent {
  return {
    eventId: doc.event_id.toUUID().toString(),
    aggregateType: doc.aggregate_type,
    aggregateId: doc.aggregate_id.toUUID().toString(),
    organizationId: doc.organization_id.toUUID().toString(),
    eventType: doc.event_type,
    eventVersion: doc.event_version,
    payload: doc.payload ?? null,
    partitionKey: doc.partition_key,
    status: doc.status,
    attemptCount: doc.attempt_count,
    nextAttemptAt: doc.next_attempt_at.toISOString(),
    traceId: doc.trace_id ?? null,
    correlationId: doc.correlation_id ? doc.correlation_id.toUUID().toString() : null,
    createdAt: doc.created_at_us,
    publishedAt: doc.published_at ? doc.published_at.toISOString() : null,
    claimedAt: doc.claimed_at ? doc.claimed_at.toISOString() : null,
    lastError: doc.last_error ?? null,
  };
}

export class MongoOutboxStore implements IOutboxStore {
  private readonly outbox: TenantScopedCollection<OutboxDoc>;

  constructor(
    private readonly db: Db,
    private readonly ctx: MongoTxContext,
  ) {
    this.outbox = new TenantScopedCollection<OutboxDoc>(db.collection<OutboxDoc>('outbox_events'));
  }

  private sessionOpt() {
    return { session: this.ctx.session };
  }

  /**
   * Dispatch-plane handle. The claim/mark/recover operations are keyed by
   * event_id with NO org predicate — exactly mirroring the pg lane, where the
   * dispatcher runs them under `db.withBypass` (no tenant context). The
   * unscoped choice is deliberate and stated here, not silent.
   */
  private dispatch() {
    return this.outbox.unsafeNative;
  }

  async append(input: OutboxEventInput): Promise<StoredEvent> {
    // Tenant-bound write (pg parity: recordOutboxEvent runs under withOrg, so
    // RLS enforces organization_id). Fail closed outside a tenant context.
    const orgId = this.ctx.orgId;
    if (!orgId) {
      throw new Error('MongoOutboxStore.append requires a tenant-bound context (orgId) — refusing platform-plane write');
    }
    const eventId = uuidv7();
    const now = new Date();
    // organization_id is injected by TenantScopedCollection.insertOne
    // (scopedDoc) — the cast reflects the runtime injection.
    const doc = {
      event_id: uuidToBinary(eventId),
      aggregate_type: input.aggregateType,
      aggregate_id: uuidToBinary(input.aggregateId),
      event_type: input.eventType,
      event_version: input.eventVersion ?? 1,
      payload: input.payload ?? null,
      partition_key: input.partitionKey,
      status: 'PENDING' as const,
      attempt_count: 0,
      next_attempt_at: now,
      trace_id: input.traceId ?? null,
      correlation_id: input.correlationId ? uuidToBinary(input.correlationId) : null,
      created_at: now,
      created_at_us: nowIso(now),
      published_at: null,
      claimed_at: null,
      last_error: null,
    } as OutboxDoc;
    await this.outbox.insertOne(orgId, doc, this.sessionOpt());
    const saved = await this.dispatch().findOne({ event_id: uuidToBinary(eventId) }, this.sessionOpt());
    if (!saved) throw new Error('outbox append failed: row not found after insert');
    return mongoToStoredEvent(saved);
  }

  async claimBatch(limit: number, opts?: ClaimBatchOptions): Promise<StoredEvent[]> {
    // mongo parity of FOR UPDATE SKIP LOCKED: one atomic findOneAndUpdate per
    // claim — the filter+sort+update is a single server-side atomic op, so
    // concurrent dispatchers can never double-claim. Sort (created_at_us,
    // event_id) reproduces pg's (created_at, event_id) FIFO.
    const now = opts?.now ?? new Date();
    const filter: Filter<OutboxDoc> = {
      status: { $in: ['PENDING', 'RETRY_WAIT'] },
      next_attempt_at: { $lte: now },
    };
    if (opts?.eventTypes !== undefined) {
      filter.event_type = { $in: opts.eventTypes };
    }
    const claimed: StoredEvent[] = [];
    for (let i = 0; i < limit; i++) {
      const doc = await this.dispatch().findOneAndUpdate(
        filter,
        { $set: { status: 'CLAIMED', claimed_at: now } },
        { sort: { created_at_us: 1, event_id: 1 }, returnDocument: 'after', session: this.ctx.session },
      );
      if (!doc) break;
      claimed.push(mongoToStoredEvent(doc));
    }
    return claimed;
  }

  async markPublished(eventId: string): Promise<void> {
    // pg parity: markPublished — PUBLISHED, claim cleared, error cleared.
    await this.dispatch().updateOne(
      { event_id: uuidToBinary(eventId) },
      { $set: { status: 'PUBLISHED', published_at: new Date(), claimed_at: null, last_error: null } },
      this.sessionOpt(),
    );
  }

  async markFailed(eventId: string, error: string, retryAt: Date): Promise<number> {
    // pg parity: markRetryWait — atomic attempt_count + 1, RETRY_WAIT with the
    // caller-computed next attempt. Returns the new attempt count.
    const doc = await this.dispatch().findOneAndUpdate(
      { event_id: uuidToBinary(eventId) },
      {
        $inc: { attempt_count: 1 },
        $set: {
          status: 'RETRY_WAIT',
          next_attempt_at: retryAt,
          claimed_at: null,
          last_error: error.slice(0, 4000),
        },
      },
      { returnDocument: 'after', session: this.ctx.session },
    );
    if (!doc) throw new Error(`outbox markFailed: unknown event ${eventId}`);
    return doc.attempt_count;
  }

  async moveToDeadLetter(eventId: string, error?: string, attempt?: number): Promise<void> {
    // pg parity: markDeadLetter.
    const set: Record<string, unknown> = {
      status: 'DEAD_LETTER',
      claimed_at: null,
      last_error: error?.slice(0, 4000) ?? null,
    };
    if (attempt !== undefined) set['attempt_count'] = attempt;
    await this.dispatch().updateOne({ event_id: uuidToBinary(eventId) }, { $set: set }, this.sessionOpt());
  }

  async recoverStaleClaims(olderThanMs: number): Promise<number> {
    // pg parity: recoverStaleClaims — CLAIMED older than the lease -> PENDING.
    const cutoff = new Date(Date.now() - olderThanMs);
    const res = await this.dispatch().updateMany(
      { status: 'CLAIMED', claimed_at: { $lte: cutoff } },
      { $set: { status: 'PENDING', claimed_at: null } },
      this.sessionOpt(),
    );
    return res.modifiedCount;
  }
}

/**
 * mongo parity of claimInbox / completeInbox / failInbox (consumer.ts).
 * `inbox_events` is platform-plane by design — PlatformCollection, the same
 * deliberate choice the pg lane makes (no RLS on this table).
 */
export class MongoInboxStore implements IInboxStore {
  private readonly inbox: PlatformCollection<InboxDoc>;

  constructor(
    db: Db,
    private readonly ctx: MongoTxContext,
  ) {
    this.inbox = new PlatformCollection<InboxDoc>(db.collection<InboxDoc>('inbox_events'));
  }

  private sessionOpt() {
    return { session: this.ctx.session };
  }

  async tryClaim(key: InboxKey, opts?: { staleMs?: number }): Promise<boolean> {
    // mongo parity of the ON CONFLICT DO NOTHING claim: unique index
    // (consumer_name, event_id) + catch 11000 as claim-loss. On conflict the
    // row is read and classified exactly like claimInbox: PROCESSED => false;
    // fresh PROCESSING => false (busy); stale/receivable => reclaim => true;
    // invisible row => throw (fail closed).
    const now = new Date();
    try {
      await this.inbox.insertOne(
        {
          consumer_name: key.consumerName,
          event_id: uuidToBinary(key.eventId),
          status: 'PROCESSING',
          first_received_at: now,
          last_received_at: now,
          processed_at: null,
          result_ref: null,
          last_error: null,
        },
        this.sessionOpt(),
      );
      return true;
    } catch (err) {
      if (!(err instanceof MongoServerError) || err.code !== 11000) throw err;
    }
    const filter = { consumer_name: key.consumerName, event_id: uuidToBinary(key.eventId) };
    const row = await this.inbox.findOne(filter, this.sessionOpt());
    if (!row) {
      throw new Error(`inbox claim lost for (${key.consumerName}, ${key.eventId}) — row vanished between conflict and select`);
    }
    if (row.status === 'PROCESSED') return false;
    const claimedAt = row.last_received_at?.getTime();
    const stale = claimedAt === undefined || Number.isNaN(claimedAt) || Date.now() - claimedAt > (opts?.staleMs ?? INBOX_STALE_MS);
    if (row.status === 'PROCESSING' && !stale) return false;
    await this.inbox.updateOne(
      filter,
      { $set: { status: 'PROCESSING', last_received_at: new Date(), last_error: null } },
      this.sessionOpt(),
    );
    return true;
  }

  async complete(key: InboxKey, resultRef?: Record<string, unknown>): Promise<void> {
    await this.inbox.updateOne(
      { consumer_name: key.consumerName, event_id: uuidToBinary(key.eventId) },
      { $set: { status: 'PROCESSED', processed_at: new Date(), result_ref: resultRef ?? null } },
      this.sessionOpt(),
    );
  }

  async fail(key: InboxKey, error: string): Promise<void> {
    await this.inbox.updateOne(
      { consumer_name: key.consumerName, event_id: uuidToBinary(key.eventId) },
      { $set: { status: 'FAILED', last_error: error.slice(0, 4000) } },
      this.sessionOpt(),
    );
  }
}

export type { OutboxStatus };
