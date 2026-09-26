import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { webhookDeliveries, type WebhookDeliveryRow } from '../schema';
import { MAX_ATTEMPTS } from './webhooks.repository';
import type { CreateDeliveryInput, IWebhookDeliveryRepository } from './webhooks.repository';

/**
 * PostgreSQL implementation of `IWebhookDeliveryRepository` (P3).
 *
 * Mechanical move of the `WebhooksService` delivery-row units: every method
 * owns its transaction via `DbService.withOrg` (RLS) or `withBypass` (the
 * worker/sweep drain the cross-org queue by unique row id). No transaction
 * handle leaks through this interface.
 *
 * What stays OUT (still the service's job): the BullMQ enqueue (the row
 * insert and the enqueue are two separate durable steps by design), the
 * backoff-table math, and the `WebhookDead` event emission.
 */
export class PgWebhookDeliveryRepository implements IWebhookDeliveryRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert a `pending` delivery row (one withOrg unit); returns the row id.
   */
  async createDelivery(input: CreateDeliveryInput): Promise<string> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(webhookDeliveries)
        .values({
          orgId: input.orgId,
          webhookId: input.webhookId,
          eventType: input.eventType,
          payload: { type: input.eventType, created_at: new Date().toISOString(), data: input.data },
          status: 'pending',
        })
        .returning({ id: webhookDeliveries.id }),
    );
    return inserted[0].id;
  }

  /**
   * Bypass read by id (the worker drains the cross-org queue — addressed by
   * the delivery's unique id, no tenant scope).
   */
  async getDeliveryUnchecked(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1),
    );
    return rows[0] ?? null;
  }

  /** Delivery log for one webhook, newest first (limit clamped 1..200 by the caller). */
  async listDeliveries(orgId: string, webhookId: string, limit: number, offset: number): Promise<WebhookDeliveryRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.orgId, orgId), eq(webhookDeliveries.webhookId, webhookId)))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit)
        .offset(offset),
    );
  }

  /** Terminal success: sets `delivered` + `delivered_at`. */
  async markDeliveryDelivered(orgId: string, deliveryId: string, responseStatus: number): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'delivered', responseStatus, deliveredAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(webhookDeliveries.id, deliveryId)),
    );
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
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'failed', attempts, lastError, nextAttemptAt, updatedAt: new Date().toISOString() })
        .where(eq(webhookDeliveries.id, deliveryId)),
    );
  }

  /**
   * Terminal failure: sets `dead` with the final error; `attempts` is set
   * when the caller passes it (retry exhaustion), left untouched otherwise.
   */
  async markDeliveryDead(orgId: string, deliveryId: string, lastError: string, attempts?: number): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          status: 'dead',
          lastError,
          ...(attempts !== undefined ? { attempts } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(webhookDeliveries.id, deliveryId)),
    );
  }

  /**
   * Enqueue-failure park: the row exists but no job was queued — mark it
   * `failed` with an imminent `nextAttemptAt` so the stranded-delivery sweep
   * picks it up instead of leaving it `pending` forever.
   */
  async parkEnqueueFailure(orgId: string, deliveryId: string, lastError: string, nextAttemptAt: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'failed', attempts: 0, lastError, nextAttemptAt, updatedAt: new Date().toISOString() })
        .where(eq(webhookDeliveries.id, deliveryId)),
    );
  }

  /**
   * Stranded-delivery claim (P5-W13, bypass): claims up to `batchSize`
   * stranded rows with `FOR UPDATE SKIP LOCKED` so concurrent sweeps/workers
   * never double-claim; the deterministic jobId makes even a raced re-enqueue
   * a no-op instead of a double delivery.
   */
  async claimStrandedDeliveries(batchSize: number): Promise<Array<{ id: string; attempts: number }>> {
    const claimed = await this.db.withBypass((tx) =>
      // Justification (withBypass): the sweep drains cross-org rows by id —
      // the reconciliation is org-scoped per row by the delivery's own org_id.
      tx.execute<{
        id: string;
        attempts: number;
      }>(sql`
        update webhook_deliveries
        set updated_at = now()
        where id in (
          select id from webhook_deliveries
          where (
            (status = 'pending' and created_at < now() - interval '5 minutes')
            or (status = 'failed' and next_attempt_at is not null and next_attempt_at <= now() and attempts < ${MAX_ATTEMPTS})
          )
          order by created_at
          limit ${batchSize}
          for update skip locked
        )
        returning id, attempts
      `),
    );
    return claimed.rows.map((row) => ({ id: row.id, attempts: row.attempts }));
  }
}
