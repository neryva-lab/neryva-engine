/**
 * Channel-event repository (P3) — the persistence port for `channel_events`
 * (the durable webhook envelope log + redelivery dedup anchor).
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: the ingest half runs under `db.withBypass` (no tenant
 * context on the public webhook path — the account row already resolved the
 * tenant), so the org travels explicitly in the document/row and in the
 * outbox payload, mirroring the pg lane exactly. The MongoDB implementation
 * applies the same explicit `organization_id` scoping.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
import type { ChannelEvent } from '../schema';

export type WebhookRecordOutcome = 'accepted' | 'duplicate';

export interface IChannelEventRepository {
  /**
   * Durable webhook receipt: insert the bounded envelope + announce
   * `channel.event.received` on the outbox in ONE transaction (invariant 7).
   * The (channel_account_id, external_event_id) unique key makes provider
   * redelivery idempotent: a redelivered event returns `duplicate` and
   * writes nothing (no second outbox event).
   */
  recordWebhookEvent(input: {
    accountId: string;
    orgId: string;
    platform: string;
    boundedRaw: string;
    externalEventId: string;
    normalizedKind: string;
    signatureOk: boolean;
  }): Promise<WebhookRecordOutcome>;

  /** Bypass read of one stored envelope for the outbox consumer. */
  getEventByIdForIngest(eventId: string): Promise<ChannelEvent | null>;

  /** Settle the event (processed / quarantined) — bypass write. */
  settleEvent(eventId: string, status: 'processed' | 'quarantined', error?: string): Promise<void>;
}
