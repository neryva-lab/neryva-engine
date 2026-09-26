/**
 * Webhook repository ports (P3) — the persistence interface for the outbound
 * webhooks plane (`WebhooksService` CRUD/secret rotation and the delivery
 * lifecycle: enqueue, claim, status transitions, retries).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every tenant method takes the organization id
 * explicitly. The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `org_id` predicate on every tenant collection access (there is no
 * RLS on that lane). Bypass reads are marked `Unchecked` and address rows by
 * their unique id — the worker drains the cross-org delivery queue, so no
 * tenant scope applies; the reconciliation is org-scoped per row by the
 * delivery's own `org_id`.
 *
 * Row types are imported as *types only* from the module schema — the
 * interfaces carry no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repositories (still the service's job):
 * - input validation (`checkWebhookUrl`, `validateEvents`, limit clamps)
 * - the SSRF delivery-time re-check (`recheckWebhookTarget`)
 * - audit writes (replayed by the service from inputs + results)
 * - the engine event bus + BullMQ enqueue (retries are scheduled by the
 *   service with its backoff table; the repository only persists the state)
 * - secret generation / envelope crypto (the service passes the envelope)
 * - tracing spans (`withSpan`)
 */
import type { webhooks, WebhookDeliveryRow, WebhookRow } from '../schema';

/** Bounded retry budget for a delivery attempt chain (service backoff table below). */
export const MAX_ATTEMPTS = 5;
/** Per-attempt delays (ms); the service picks `RETRY_DELAYS_MS[attempts - 1]`. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;

/** Full-row insert shape for the `webhooks` table (service-normalized). */
export type WebhookInsert = typeof webhooks.$inferInsert;

/** Partial update for a webhook row (the service builds the patch). */
export type WebhookUpdatePatch = Partial<WebhookInsert>;

export interface CreateWebhookInput {
  orgId: string;
  url: string;
  /** Validated + normalized event list (['*'] or the public vocabulary). */
  events: string[];
  /** Already sliced to 256 chars by the service; undefined = null. */
  description?: string;
  /** Envelope-encrypted signing secret (`enc:v1:`) — never plaintext. */
  secretEnvelope: string;
}

export interface IWebhookRepository {
  /** Insert a webhook row (one withOrg unit); returns the raw row. */
  createWebhook(input: CreateWebhookInput): Promise<WebhookRow>;

  /** Raw row read (withOrg); the service applies the notFound mapping. */
  getWebhook(orgId: string, webhookId: string): Promise<WebhookRow | null>;

  /**
   * Bypass read by id (the worker drains the cross-org queue — the delivery
   * row is addressed by its unique id, so no tenant scope applies).
   */
  getWebhookUnchecked(webhookId: string): Promise<WebhookRow | null>;

  /** All webhooks of an org, newest first. */
  listWebhooks(orgId: string): Promise<WebhookRow[]>;

  /** Subscribed + active targets for the dispatch fan-out. */
  listActiveWebhooks(orgId: string): Promise<WebhookRow[]>;

  /**
   * Patch a webhook row (one withOrg unit). Returns the first updated row —
   * exactly the original `updated[0]`: `require` and the update are separate
   * units, so a row deleted between them yields `undefined` at runtime
   * (typed as `WebhookRow`, as drizzle's `returning()` did). The service
   * preserves the original behavior for that case (audit written, `{}` redacted
   * out) — the require/update race is a KNOWN pre-existing bug, recorded
   * here and NOT fixed by this extraction.
   */
  updateWebhook(
    orgId: string,
    webhookId: string,
    patch: WebhookUpdatePatch,
  ): Promise<WebhookRow>;

  /** Delete a webhook row (cascade drops its deliveries). */
  deleteWebhook(orgId: string, webhookId: string): Promise<void>;

  /** Rotate the signing secret (old one dies immediately). */
  rotateSecret(orgId: string, webhookId: string, secretEnvelope: string): Promise<void>;
}

export interface CreateDeliveryInput {
  orgId: string;
  webhookId: string;
  eventType: string;
  /** The event data; the repository wraps it in the delivery envelope. */
  data: Record<string, unknown>;
}

export interface IWebhookDeliveryRepository {
  /**
   * Insert a `pending` delivery row (one withOrg unit); returns the row id.
   * The BullMQ enqueue stays the service's job — the row insert and the
   * enqueue are two separate durable steps by design.
   */
  createDelivery(input: CreateDeliveryInput): Promise<string>;

  /**
   * Bypass read by id (the worker drains the cross-org queue — addressed by
   * the delivery's unique id, no tenant scope).
   */
  getDeliveryUnchecked(deliveryId: string): Promise<WebhookDeliveryRow | null>;

  /** Delivery log for one webhook, newest first (limit clamped 1..200 by the caller). */
  listDeliveries(orgId: string, webhookId: string, limit: number, offset: number): Promise<WebhookDeliveryRow[]>;

  /** Terminal success: sets `delivered` + `delivered_at`. */
  markDeliveryDelivered(orgId: string, deliveryId: string, responseStatus: number): Promise<void>;

  /**
   * Non-terminal failure: sets `failed` with the attempt count, the error,
   * and the next-attempt instant (the service computes these from the
   * backoff table).
   */
  markDeliveryRetryable(
    orgId: string,
    deliveryId: string,
    attempts: number,
    lastError: string,
    nextAttemptAt: string,
  ): Promise<void>;

  /**
   * Terminal failure: sets `dead` with the final error; `attempts` is set
   * when the caller passes it (retry exhaustion), left untouched otherwise
   * (disabled/removed hook, unreadable secret — no attempt was made).
   */
  markDeliveryDead(orgId: string, deliveryId: string, lastError: string, attempts?: number): Promise<void>;

  /**
   * Enqueue-failure park: the row exists but no job was queued — mark it
   * `failed` with an imminent `nextAttemptAt` so the stranded-delivery sweep
   * picks it up instead of leaving it `pending` forever.
   */
  parkEnqueueFailure(orgId: string, deliveryId: string, lastError: string, nextAttemptAt: string): Promise<void>;

  /**
   * Stranded-delivery claim (bypass, atomic): claims up to `batchSize`
   * stranded rows — `pending` rows older than 5 minutes that were never
   * picked up, and `failed` rows whose `nextAttemptAt` is past with attempts
   * left. Overlapping claims never double-claim a row: on the pg lane this
   * is `FOR UPDATE SKIP LOCKED`; on the mongo lane the claim arbitrates
   * through the `webhook_delivery_claims` link collection (unique
   * `{ org_id, delivery_id }` — one insert wins per row), released at the
   * end of the claim unit like pg's transaction-scoped locks. The returned
   * `attempts` feeds the deterministic jobId so even a raced re-enqueue is
   * a dedup no-op instead of a double delivery.
   */
  claimStrandedDeliveries(batchSize: number): Promise<Array<{ id: string; attempts: number }>>;
}
