/**
 * MongoDB lane for `IWebhookDeliveryRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg`/`withBypass` unit (plan D5); the tenant predicate (`org_id`)
 * is enforced by `TenantScopedCollection` (plan D6). Mongo does NOT apply pg
 * column defaults — `id` (uuidv7), `status`, `attempts`, `created_at`,
 * `updated_at` are set explicitly on every insert.
 *
 * Claim races: the stranded-delivery claim arbitrates through the
 * `webhook_delivery_claims` link collection (unique `{ org_id, delivery_id
 * }`) — the `FOR UPDATE SKIP LOCKED` equivalent and the same claim-via-link
 * pattern the channels plane uses (`channel_message_links`). Of any set of
 * overlapping claimants exactly one insert wins per row; the losers see a
 * duplicate key and skip it. Claims are released at the end of the claim
 * unit — mirroring pg, where the row locks die at transaction commit — so
 * only *overlapping* claims are disjoint; a later sweep may claim the row
 * again. `expires_at` (TTL) is purely a crash backstop.
 *
 * Shared helpers (typed document shapes, `binUuid`) live in
 * `./mongo-documents.ts`.
 */
import type { Binary, Db, Filter } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { WebhookDeliveryRow } from '../schema';
import {
  binUuid,
  isDuplicateKey,
  tenantCollection,
  toWebhookDelivery,
  uuidOf,
  type WebhookDeliveryClaimDoc,
  type WebhookDeliveryMongoDoc,
} from './mongo-documents';
import { MAX_ATTEMPTS } from './webhooks.repository';
import type { CreateDeliveryInput, IWebhookDeliveryRepository } from './webhooks.repository';

/** Name of the sweep-claim link collection (see `WebhookDeliveryClaimDoc`). */
const DELIVERY_CLAIM_COLLECTION = 'webhook_delivery_claims';

/**
 * Crash backstop for claim docs: a claim is held only for the claim unit
 * (milliseconds) and released at its end; the TTL bounds the damage if this
 * host dies between claim and release. Five minutes is a few sweep ticks
 * (the sweep interval defaults to 60s) — the row is never stranded forever.
 */
const DELIVERY_CLAIM_TTL_MS = 5 * 60_000;

let deliveryClaimIndexesEnsured = false;

/**
 * Ensure the claim collection's indexes. NOT in the checksum-pinned
 * `0001_engine_core` mongo migration (that file is tamper-evident and must
 * not be edited) — `createIndex` with the same name+spec is a no-op when the
 * index already exists, so this is safe to call on every claim.
 */
async function ensureDeliveryClaimIndexes(db: Db): Promise<void> {
  if (deliveryClaimIndexesEnsured) return;
  const coll = db.collection<WebhookDeliveryClaimDoc>(DELIVERY_CLAIM_COLLECTION);
  await coll.createIndex(
    { org_id: 1, delivery_id: 1 },
    { name: 'uq_delivery_claims_org_delivery', unique: true },
  );
  await coll.createIndex(
    { expires_at: 1 },
    { name: 'ix_delivery_claims_expires', expireAfterSeconds: 0 },
  );
  deliveryClaimIndexesEnsured = true;
}

export class MongoWebhookDeliveryRepository implements IWebhookDeliveryRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return {
      session: { session: ctx.session },
      deliveries: tenantCollection<WebhookDeliveryMongoDoc>(db, 'webhook_deliveries'),
    };
  }

  /**
   * Insert a `pending` delivery row (one withOrg unit); returns the row id.
   */
  async createDelivery(input: CreateDeliveryInput): Promise<string> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = new Date().toISOString();
      const deliveryId = uuidv7();
      const doc: WebhookDeliveryMongoDoc = {
        id: binUuid(deliveryId),
        org_id: binUuid(input.orgId, 'orgId'),
        webhook_id: binUuid(input.webhookId, 'webhookId'),
        event_type: input.eventType,
        payload: { type: input.eventType, created_at: now, data: input.data },
        status: 'pending',
        attempts: 0,
        last_error: null,
        response_status: null,
        delivered_at: null,
        next_attempt_at: null,
        created_at: now,
        updated_at: now,
      };
      await t.deliveries.insertOne(input.orgId, doc, t.session);
      return deliveryId;
    });
  }

  /**
   * Bypass read by id (the worker drains the cross-org queue — addressed by
   * the delivery's unique id, no tenant scope). `unsafeNative` with an
   * explicit id predicate; safe because the row is addressed by its
   * unguessable unique id from the queued job.
   */
  async getDeliveryUnchecked(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.deliveries.unsafeNative.findOne(
        { id: binUuid(deliveryId, 'deliveryId') },
        { session: ctx.session },
      );
      return row ? toWebhookDelivery(row) : null;
    });
  }

  /** Delivery log for one webhook, newest first (limit clamped 1..200 by the caller). */
  async listDeliveries(orgId: string, webhookId: string, limit: number, offset: number): Promise<WebhookDeliveryRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.deliveries
        .find(orgId, { webhook_id: binUuid(webhookId, 'webhookId') }, t.session)
        .sort({ created_at: -1 })
        .skip(Math.max(offset, 0))
        .limit(Math.min(Math.max(limit, 1), 200))
        .toArray();
      return rows.map(toWebhookDelivery);
    });
  }

  /** Terminal success: sets `delivered` + `delivered_at`. */
  async markDeliveryDelivered(orgId: string, deliveryId: string, responseStatus: number): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = new Date().toISOString();
      await t.deliveries.updateOne(
        orgId,
        { id: binUuid(deliveryId, 'deliveryId') },
        { $set: { status: 'delivered', response_status: responseStatus, delivered_at: now, updated_at: now } },
        t.session,
      );
    });
  }

  /**
   * Non-terminal failure: sets `failed` with the attempt count, the error,
   * and the next-attempt instant (computed by the service from the backoff
   * table).
   */
  async markDeliveryRetryable(
    orgId: string,
    deliveryId: string,
    attempts: number,
    lastError: string,
    nextAttemptAt: string,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.deliveries.updateOne(
        orgId,
        { id: binUuid(deliveryId, 'deliveryId') },
        {
          $set: {
            status: 'failed',
            attempts,
            last_error: lastError,
            next_attempt_at: nextAttemptAt,
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }

  /**
   * Terminal failure: sets `dead` with the final error; `attempts` is set
   * when the caller passes it (retry exhaustion), left untouched otherwise.
   */
  async markDeliveryDead(orgId: string, deliveryId: string, lastError: string, attempts?: number): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.deliveries.updateOne(
        orgId,
        { id: binUuid(deliveryId, 'deliveryId') },
        {
          $set: {
            status: 'dead',
            last_error: lastError,
            ...(attempts !== undefined ? { attempts } : {}),
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }

  /**
   * Enqueue-failure park: the row exists but no job was queued — mark it
   * `failed` with an imminent `nextAttemptAt` so the stranded-delivery sweep
   * picks it up instead of leaving it `pending` forever.
   */
  async parkEnqueueFailure(orgId: string, deliveryId: string, lastError: string, nextAttemptAt: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.deliveries.updateOne(
        orgId,
        { id: binUuid(deliveryId, 'deliveryId') },
        {
          $set: {
            status: 'failed',
            attempts: 0,
            last_error: lastError,
            next_attempt_at: nextAttemptAt,
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }

  /**
   * Stranded-delivery claim (bypass, atomic): claims up to `batchSize`
   * stranded rows with exactly-one-winner semantics for overlapping calls —
   * the `FOR UPDATE SKIP LOCKED` equivalent.
   *
   * Justification (bypass): the sweep drains cross-org rows; each candidate
   * carries its own `org_id` and every claim doc is tenant-keyed per row —
   * the pg lane runs this same query under `withBypass`.
   *
   * Protocol: scan stranded candidates oldest-first, then arbitrate each one
   * by inserting its claim doc (unique `{ org_id, delivery_id }`) — the
   * insert is deliberately NON-transactional so a lost race surfaces as a
   * plain duplicate key instead of failing the whole unit. Winners get the
   * mechanical `updated_at` bump the pg lane applies; claims are released at
   * the end of the unit (pg releases its row locks at transaction commit).
   * Transaction bodies must be idempotent across retries (`runInTransaction`
   * may re-run): already-won rows are tracked outside the body and skipped
   * on re-scan, and the `updated_at` bump is an idempotent `$set`.
   */
  async claimStrandedDeliveries(batchSize: number): Promise<Array<{ id: string; attempts: number }>> {
    const db = this.mongo.root;
    await ensureDeliveryClaimIndexes(db);
    const limit = Math.min(Math.max(batchSize, 1), 500);
    const now = new Date();
    const nowIso = now.toISOString();
    const strandedCutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
    const deliveries = db.collection<WebhookDeliveryMongoDoc>('webhook_deliveries');
    const claims = tenantCollection<WebhookDeliveryClaimDoc>(db, DELIVERY_CLAIM_COLLECTION);

    const stranded: Filter<WebhookDeliveryMongoDoc> = {
      $or: [
        { status: 'pending', created_at: { $lt: strandedCutoff } },
        {
          status: 'failed',
          next_attempt_at: { $ne: null, $lte: nowIso },
          attempts: { $lt: MAX_ATTEMPTS },
        },
      ],
    };

    // Won rows, keyed by delivery uuid — declared OUTSIDE the retry body so
    // a transient transaction retry skips rows this call already won
    // (their claim inserts are non-transactional and survive the retry).
    const won = new Map<string, { attempts: number; orgId: string }>();
    const seen: Binary[] = [];
    try {
      await this.mongo.withBypass(async (ctx) => {
        const sessionOpt = { session: ctx.session };
        while (won.size < limit) {
          const batch = await deliveries
            .find(
              { ...stranded, ...(seen.length > 0 ? { id: { $nin: seen } } : {}) },
              sessionOpt,
            )
            .sort({ created_at: 1 })
            .limit(limit - won.size)
            .toArray();
          if (batch.length === 0) break;
          let progressed = false;
          for (const row of batch) {
            seen.push(row.id);
            const id = uuidOf(row.id);
            if (won.has(id)) continue;
            const orgId = uuidOf(row.org_id);
            try {
              await claims.insertOne(orgId, {
                org_id: row.org_id,
                delivery_id: row.id,
                claimed_at: nowIso,
                expires_at: new Date(now.getTime() + DELIVERY_CLAIM_TTL_MS),
              });
            } catch (err) {
              if (isDuplicateKey(err)) continue; // lost the race — another claimant won this row
              throw err;
            }
            progressed = true;
            won.set(id, { attempts: row.attempts, orgId });
            await deliveries.updateOne({ id: row.id }, { $set: { updated_at: nowIso } }, sessionOpt);
          }
          if (!progressed) break; // every remaining candidate is claimed by someone else
        }
      });
    } finally {
      // Release the claims — only overlapping claims must be disjoint.
      for (const [id, w] of won) {
        await claims.deleteOne(w.orgId, { delivery_id: binUuid(id) }).catch(() => undefined);
      }
    }
    return [...won].map(([id, w]) => ({ id, attempts: w.attempts }));
  }
}
