import { Binary, MongoServerError, type ClientSession, type Db } from 'mongodb';
import { and, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { ApiError } from '../../../http/api-error';
import { MongoTxContext, uuidToBinary } from '../mongo/mongo-tx';
import { TenantScopedCollection } from '../mongo/concurrency/tenant-guard';

/**
 * Durable idempotency tier — provider port (plan P2, D2/D4/D7).
 *
 * This file ports the DURABLE DB authority tier of the engine's two-tier
 * idempotency design. The Redis fast-path lease (`src/common/http/idempotency.ts`)
 * is untouched. The semantics below are a 1:1 move of
 * `src/common/http/idempotency-records.ts` (claim / complete / fail / purge)
 * plus a `get` for replay reads; the MongoDB implementation mirrors every
 * branch of the pg one.
 *
 * Uniqueness scope (engine invariant 4, engine_architecture.md:243-247):
 * `organization_id + principal_id + endpoint_family + idempotency_key`.
 *
 * pg source of truth for statuses: `drizzle/0023_async_foundation.sql`
 * `CONSTRAINT "chk_idem_status" CHECK (status IN
 * ('IN_PROGRESS','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL'))`.
 * The Mongo collection validator in `mongo/0001_engine_core.ts`
 * (`idempotency_records`) enforces the same enum.
 *
 * `tryClaim` result mapping onto the pg `claimIdempotency` outcomes:
 * - pg `claimed`                        → `'claimed'`
 * - pg `replay` (SUCCEEDED row)         → `'duplicate'` (fetch the stored
 *   response with `get()` and replay it — same as the pg caller's
 *   `claim.response` path)
 * - pg 409 `idempotency_in_flight`      → throws `ApiError(409,
 *   'idempotency_in_flight', ...)` — in-flight unexpired row, or the
 *   fail-closed "conflict but row invisible" case
 * - pg 409 `idempotency_conflict`       → throws `ApiError(409,
 *   'idempotency_conflict', ...)` — same key + different request hash, or
 *   FAILED_FINAL row
 *
 * `failIdempotency` from the pg module is not a port method (no caller
 * outside the domain services uses it yet); the FAILED_RETRYABLE /
 * FAILED_FINAL states are still honored on the `tryClaim` read path of both
 * implementations so re-claim and terminal semantics stay identical.
 */

/** Exact pg `chk_idem_status` values — never add/remove without a migration. */
export const IDEMPOTENCY_STATUSES = [
  'IN_PROGRESS',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

/** Durable claim key. `requestHash` is the method+path+body sha256 fingerprint:
 * when supplied, same-key + different-hash is a typed 409 (never a silent
 * overwrite), exactly like the pg tier. Callers must pass it for the
 * fingerprint guard (engine invariant 4); the store never invents one. */
export interface IdempotencyKey {
  organizationId: string;
  principalId: string;
  endpointFamily: string;
  idempotencyKey: string;
  requestHash?: string;
}

/** Durable recorded response, stored verbatim in `resource_ref`. */
export interface IdempotencyResponse {
  statusCode: number;
  bodyHash?: string;
  body?: unknown;
}

/** Row/document read back for replay. */
export interface IdempotencyRecord {
  organizationId: string;
  principalId: string;
  endpointFamily: string;
  idempotencyKey: string;
  requestHash: string | null;
  status: IdempotencyStatus;
  /** The response recorded by `complete` — replay this verbatim. */
  response: IdempotencyResponse | null;
  createdAt: string;
  expiresAt: string;
}

export interface IIdempotencyStore {
  /**
   * Claim the key inside the caller's transaction. Returns `'claimed'` when
   * this request owns the key (fresh claim, or re-claim of a
   * FAILED_RETRYABLE / expired IN_PROGRESS row), `'duplicate'` when the key
   * already completed (SUCCEEDED — fetch the stored response with `get()`).
   * Throws `ApiError(409, 'idempotency_conflict' | 'idempotency_in_flight')`
   * for hash mismatch, in-flight, or terminally-failed rows.
   */
  tryClaim(key: IdempotencyKey, ttlMs: number): Promise<'claimed' | 'duplicate'>;
  /** Record the durable outcome in the SAME transaction as the side effect. */
  complete(key: IdempotencyKey, response: IdempotencyResponse): Promise<void>;
  /** Fetch the record for replay; null when the key was never claimed. */
  get(key: IdempotencyKey): Promise<IdempotencyRecord | null>;
  /**
   * Bounded-growth sweep: delete records that expired more than
   * `olderThanMs` ago (by `expires_at`, any status — mirrors the pg sweep).
   * `releaseExpired(0)` is exactly `purgeExpiredIdempotencyRecords` from the
   * pg module. Returns the number purged. Safe to run concurrently.
   */
  releaseExpired(olderThanMs: number): Promise<number>;
}

// ── pg table (1:1 copy of the table object in
// src/common/http/idempotency-records.ts — NOT imported, duplicated per the
// port rule so this module owns its persistence contract) ────────────────

const idempotencyRecords = pgTable(
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

function pgFilter(key: IdempotencyKey) {
  return and(
    eq(idempotencyRecords.organizationId, key.organizationId),
    eq(idempotencyRecords.principalId, key.principalId),
    eq(idempotencyRecords.endpointFamily, key.endpointFamily),
    eq(idempotencyRecords.idempotencyKey, key.idempotencyKey),
  );
}

function inFlight(): ApiError {
  return new ApiError(409, 'idempotency_in_flight', 'A request with this Idempotency-Key is currently in flight');
}

/** pg lane — mechanical move of the query code from
 * `src/common/http/idempotency-records.ts` (claimIdempotency /
 * completeIdempotency / purgeExpiredIdempotencyRecords). Same predicates,
 * same TTL/expiry logic, same error codes. */
export class PgIdempotencyStore implements IIdempotencyStore {
  constructor(private readonly tx: NodePgDatabase) {}

  async tryClaim(key: IdempotencyKey, ttlMs: number): Promise<'claimed' | 'duplicate'> {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const inserted = await this.tx
      .insert(idempotencyRecords)
      .values({
        organizationId: key.organizationId,
        principalId: key.principalId,
        endpointFamily: key.endpointFamily,
        idempotencyKey: key.idempotencyKey,
        requestHash: key.requestHash ?? '',
        status: 'IN_PROGRESS',
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.idempotencyKey });

    if (inserted.length > 0) {
      return 'claimed';
    }

    const existing = await this.tx
      .select({
        requestHash: idempotencyRecords.requestHash,
        status: idempotencyRecords.status,
        resourceRef: idempotencyRecords.resourceRef,
        expiresAt: idempotencyRecords.expiresAt,
      })
      .from(idempotencyRecords)
      .where(pgFilter(key))
      .limit(1);
    const row = existing[0];
    if (!row) {
      // PK conflict reported but the row is invisible: RLS-scoped caller
      // racing a bypass writer. Fail closed rather than double-execute.
      throw new ApiError(409, 'idempotency_in_flight', 'idempotency key is being processed by another scope');
    }
    if (key.requestHash !== undefined && row.requestHash !== key.requestHash) {
      throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body');
    }
    if (row.status === 'SUCCEEDED') {
      // Replays are served for the full record lifetime — an expired
      // SUCCEEDED row is reclaimed by the sweep, never by a retrying caller.
      return 'duplicate';
    }
    const expired = Date.parse(row.expiresAt) < Date.now();
    if (row.status === 'FAILED_RETRYABLE' || (row.status === 'IN_PROGRESS' && expired)) {
      // Re-claim for this attempt: same hash, restart the in-progress window.
      // An IN_PROGRESS row past its expiry means its owning transaction was
      // lost (crash before commit of the completing update) — the key must
      // become executable again instead of 409-ing forever.
      await this.tx
        .update(idempotencyRecords)
        .set({ status: 'IN_PROGRESS', expiresAt })
        .where(pgFilter(key));
      return 'claimed';
    }
    if (row.status === 'FAILED_FINAL') {
      throw new ApiError(409, 'idempotency_conflict', 'original request failed terminally; use a new Idempotency-Key');
    }
    throw inFlight();
  }

  async complete(key: IdempotencyKey, response: IdempotencyResponse): Promise<void> {
    await this.tx
      .update(idempotencyRecords)
      .set({ status: 'SUCCEEDED', resourceRef: response as unknown as Record<string, unknown> })
      .where(pgFilter(key));
  }

  async get(key: IdempotencyKey): Promise<IdempotencyRecord | null> {
    const rows = await this.tx
      .select()
      .from(idempotencyRecords)
      .where(pgFilter(key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      organizationId: row.organizationId,
      principalId: row.principalId,
      endpointFamily: row.endpointFamily,
      idempotencyKey: row.idempotencyKey,
      requestHash: row.requestHash || null,
      status: row.status as IdempotencyStatus,
      response: (row.resourceRef as IdempotencyResponse | null) ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  async releaseExpired(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const deleted = await this.tx
      .delete(idempotencyRecords)
      .where(lt(idempotencyRecords.expiresAt, cutoff))
      .returning({ key: idempotencyRecords.idempotencyKey });
    return deleted.length;
  }
}

// ── Mongo document model (plan D4: relational-shape, same snake_case field
// names as pg; UUIDs as BSON binary subtype 4) ─────────────────────────────

interface IdempotencyMongoDoc {
  organization_id: Binary;
  principal_id: string;
  endpoint_family: string;
  idempotency_key: string;
  request_hash: string | null;
  status: IdempotencyStatus;
  resource_ref: IdempotencyResponse | null;
  created_at: string;
  expires_at: string;
}

/**
 * Mongo lane. Every op runs inside the caller's session (`ctx.session`) so a
 * withOrg callback's multi-document transaction covers claim → side effect →
 * complete atomically (plan D5). Tenant predicate is enforced by
 * `TenantScopedCollection` on every access (plan D6); a null `orgId`
 * (bypass/platform-plane) is refused at construction — idempotency keys are
 * always tenant-scoped on the pg lane and the port keeps that.
 */
export class MongoIdempotencyStore implements IIdempotencyStore {
  private readonly col: TenantScopedCollection<IdempotencyMongoDoc>;
  private readonly orgId: string;
  private readonly session: ClientSession;

  constructor(
    db: Db,
    ctx: MongoTxContext,
  ) {
    if (ctx.orgId === null || ctx.orgId.trim().length === 0) {
      throw new Error('MongoIdempotencyStore: orgId is required — refusing unscoped idempotency access');
    }
    this.orgId = ctx.orgId;
    this.session = ctx.session;
    this.col = new TenantScopedCollection<IdempotencyMongoDoc>(
      db.collection<IdempotencyMongoDoc>('idempotency_records'),
    );
  }

  /**
   * Defensive index provisioning. The release migration
   * `mongo/0001_engine_core.ts` already provisions `pk_idempotency_records`
   * (unique compound on the four scope columns) and `ix_idempotency_expiry`;
   * `createIndex` is idempotent, so calling this is safe anywhere — tests,
   * one-off scripts — without double-provisioning in production.
   */
  static async ensureIndexes(db: Db): Promise<void> {
    const col = db.collection('idempotency_records');
    await col.createIndex(
      { organization_id: 1, principal_id: 1, endpoint_family: 1, idempotency_key: 1 },
      { unique: true, name: 'pk_idempotency_records' },
    );
    await col.createIndex({ expires_at: 1 }, { name: 'ix_idempotency_expiry' });
  }

  private filter(key: IdempotencyKey): {
    principal_id: string;
    endpoint_family: string;
    idempotency_key: string;
  } {
    return {
      principal_id: key.principalId,
      endpoint_family: key.endpointFamily,
      idempotency_key: key.idempotencyKey,
    };
  }

  async tryClaim(key: IdempotencyKey, ttlMs: number): Promise<'claimed' | 'duplicate'> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    try {
      await this.col.insertOne(
        this.orgId,
        {
          organization_id: uuidToBinary(this.orgId),
          principal_id: key.principalId,
          endpoint_family: key.endpointFamily,
          idempotency_key: key.idempotencyKey,
          request_hash: key.requestHash ?? null,
          status: 'IN_PROGRESS',
          resource_ref: null,
          created_at: now.toISOString(),
          expires_at: expiresAt,
        },
        { session: this.session },
      );
      return 'claimed';
    } catch (err) {
      // Unique-index conflict = somebody owns this key. 11000 is the
      // claim-loss signal (plan D7); anything else is a real failure.
      if (!(err instanceof MongoServerError) || err.code !== 11000) {
        throw err;
      }
    }

    const row = await this.col.findOne(this.orgId, this.filter(key), { session: this.session });
    if (!row) {
      // Unique conflict reported but the document is invisible (racing
      // writer outside this transaction's snapshot). Fail closed rather
      // than double-execute — mirrors the pg fail-closed branch.
      throw new ApiError(409, 'idempotency_in_flight', 'idempotency key is being processed by another scope');
    }
    if (key.requestHash !== undefined && row.request_hash !== key.requestHash) {
      throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body');
    }
    if (row.status === 'SUCCEEDED') {
      return 'duplicate';
    }
    const expired = Date.parse(row.expires_at) < Date.now();
    if (row.status === 'FAILED_RETRYABLE' || (row.status === 'IN_PROGRESS' && expired)) {
      await this.col.updateOne(
        this.orgId,
        this.filter(key),
        { $set: { status: 'IN_PROGRESS', expires_at: expiresAt } },
        { session: this.session },
      );
      return 'claimed';
    }
    if (row.status === 'FAILED_FINAL') {
      throw new ApiError(409, 'idempotency_conflict', 'original request failed terminally; use a new Idempotency-Key');
    }
    throw inFlight();
  }

  async complete(key: IdempotencyKey, response: IdempotencyResponse): Promise<void> {
    await this.col.updateOne(
      this.orgId,
      this.filter(key),
      { $set: { status: 'SUCCEEDED', resource_ref: response } },
      { session: this.session },
    );
  }

  async get(key: IdempotencyKey): Promise<IdempotencyRecord | null> {
    const row = await this.col.findOne(this.orgId, this.filter(key), { session: this.session });
    if (!row) return null;
    return {
      organizationId: row.organization_id.toUUID().toString(),
      principalId: row.principal_id,
      endpointFamily: row.endpoint_family,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      status: row.status,
      response: row.resource_ref,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async releaseExpired(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const res = await this.col.deleteMany(
      this.orgId,
      { expires_at: { $lt: cutoff } },
      { session: this.session },
    );
    return res.deletedCount ?? 0;
  }
}
