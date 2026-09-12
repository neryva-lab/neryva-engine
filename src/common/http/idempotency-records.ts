import { jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, lt } from 'drizzle-orm';
import { DbService } from '../infra/db/db.service';
import { ApiError } from './api-error';

/**
 * DB authority tier for idempotency (pinned 2026-09-01: pulled forward from
 * ledger task 6.7 into Phase 4). The Redis lease (`src/common/http/idempotency.ts`)
 * is only an ephemeral fast path — durable dedupe of externally retried
 * commands happens HERE, claimed inside the same transaction as the command's
 * canonical writes. Uniqueness scope: `organization_id + principal_id +
 * endpoint_family + idempotency_key` (engine_architecture.md:243-247).
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    organizationId: uuid('organization_id').notNull(),
    principalId: varchar('principal_id', { length: 128 }).notNull(),
    endpointFamily: varchar('endpoint_family', { length: 64 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('IN_PROGRESS'),
    resourceRef: jsonb('resource_ref'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.principalId, t.endpointFamily, t.idempotencyKey] })],
);

export interface IdempotencyScope {
  organizationId: string;
  principalId: string;
  endpointFamily: string;
  idempotencyKey: string;
  requestHash: string;
  /** How long the record must serve replays (default 24h, covers retry windows). */
  ttlSeconds?: number;
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  | { kind: 'replay'; response: unknown };

/**
 * Claim the key inside the caller's transaction. Returns `claimed` when this
 * request owns the key, or `replay` with the recorded response for an exact
 * retry. Same key + different hash is a typed 409 (never a silent overwrite);
 * an in-flight duplicate is rejected with `idempotency_in_flight`.
 */
export async function claimIdempotency(tx: NodePgDatabase, scope: IdempotencyScope): Promise<IdempotencyClaim> {
  const ttl = scope.ttlSeconds ?? 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const inserted = await tx
    .insert(idempotencyRecords)
    .values({
      organizationId: scope.organizationId,
      principalId: scope.principalId,
      endpointFamily: scope.endpointFamily,
      idempotencyKey: scope.idempotencyKey,
      requestHash: scope.requestHash,
      status: 'IN_PROGRESS',
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyRecords.idempotencyKey });

  if (inserted.length > 0) {
    return { kind: 'claimed' };
  }

  const existing = await tx
    .select({
      requestHash: idempotencyRecords.requestHash,
      status: idempotencyRecords.status,
      resourceRef: idempotencyRecords.resourceRef,
      expiresAt: idempotencyRecords.expiresAt,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organizationId, scope.organizationId),
        eq(idempotencyRecords.principalId, scope.principalId),
        eq(idempotencyRecords.endpointFamily, scope.endpointFamily),
        eq(idempotencyRecords.idempotencyKey, scope.idempotencyKey),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) {
    // PK conflict reported but the row is invisible: RLS-scoped caller racing a
    // bypass writer. Fail closed rather than double-execute.
    throw new ApiError(409, 'idempotency_in_flight', 'idempotency key is being processed by another scope');
  }
  if (row.requestHash !== scope.requestHash) {
    throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body');
  }
  if (row.status === 'SUCCEEDED') {
    // Replays are served for the full record lifetime — an expired SUCCEEDED
    // row is reclaimed by the sweep, never by a retrying caller.
    return { kind: 'replay', response: row.resourceRef ?? null };
  }
  const expired = Date.parse(row.expiresAt) < Date.now();
  if (row.status === 'FAILED_RETRYABLE' || (row.status === 'IN_PROGRESS' && expired)) {
    // Re-claim for this attempt: same hash, restart the in-progress window.
    // An IN_PROGRESS row past its expiry means its owning transaction was
    // lost (crash before commit of the completing update) — the key must
    // become executable again instead of 409-ing forever.
    await tx
      .update(idempotencyRecords)
      .set({ status: 'IN_PROGRESS', expiresAt })
      .where(
        and(
          eq(idempotencyRecords.organizationId, scope.organizationId),
          eq(idempotencyRecords.principalId, scope.principalId),
          eq(idempotencyRecords.endpointFamily, scope.endpointFamily),
          eq(idempotencyRecords.idempotencyKey, scope.idempotencyKey),
        ),
      );
    return { kind: 'claimed' };
  }
  if (row.status === 'FAILED_FINAL') {
    throw new ApiError(409, 'idempotency_conflict', 'original request failed terminally; use a new Idempotency-Key');
  }
  throw new ApiError(409, 'idempotency_in_flight', 'A request with this Idempotency-Key is currently in flight');
}

/** Record the durable outcome in the SAME transaction as the side effect. */
export async function completeIdempotency(tx: NodePgDatabase, scope: IdempotencyScope, response: unknown): Promise<void> {
  await tx
    .update(idempotencyRecords)
    .set({ status: 'SUCCEEDED', resourceRef: response as Record<string, unknown> })
    .where(
      and(
        eq(idempotencyRecords.organizationId, scope.organizationId),
        eq(idempotencyRecords.principalId, scope.principalId),
        eq(idempotencyRecords.endpointFamily, scope.endpointFamily),
        eq(idempotencyRecords.idempotencyKey, scope.idempotencyKey),
      ),
    );
}

/** Mark failure — retryable keys may be re-claimed; final keys are dead. */
export async function failIdempotency(tx: NodePgDatabase, scope: IdempotencyScope, retryable: boolean): Promise<void> {
  await tx
    .update(idempotencyRecords)
    .set({ status: retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL' })
    .where(
      and(
        eq(idempotencyRecords.organizationId, scope.organizationId),
        eq(idempotencyRecords.principalId, scope.principalId),
        eq(idempotencyRecords.endpointFamily, scope.endpointFamily),
        eq(idempotencyRecords.idempotencyKey, scope.idempotencyKey),
      ),
    );
}

/**
 * Bounded-growth sweep: delete records whose replay window has passed.
 * Called from the worker host on a slow tick; safe to run concurrently
 * (deletes are keyed by expires_at only). Returns the number purged.
 */
export async function purgeExpiredIdempotencyRecords(db: DbService): Promise<number> {
  return db.withBypass(async (tx) => {
    const deleted = await tx
      .delete(idempotencyRecords)
      .where(lt(idempotencyRecords.expiresAt, new Date().toISOString()))
      .returning({ key: idempotencyRecords.idempotencyKey });
    return deleted.length;
  });
}
