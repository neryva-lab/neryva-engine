/**
 * PostgreSQL channel-event repository (P3) — `channel_events` + the durable
 * webhook receipt outbox announcement (invariant 7).
 *
 * Mechanical move of `ChannelIngestService.acceptWebhook`'s transaction:
 * envelope insert + `channel.event.received` outbox append in one TX; the
 * (channel_account_id, external_event_id) unique key makes redelivery a
 * no-op `duplicate` (no second outbox event). The outbox row and payload
 * are byte-identical to the original: `organizationId` is a NOT NULL
 * column, and `ChannelIngestConsumer` reads
 * `payload.channel_account_id` / `payload.channel_event_id`.
 */
import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import { channelEvents, type ChannelEvent } from '../schema';
import type { IChannelEventRepository, WebhookRecordOutcome } from './channel-event.repository';

export class PgChannelEventRepository implements IChannelEventRepository {
  constructor(private readonly db: DbService) {}

  async recordWebhookEvent(input: {
    accountId: string;
    orgId: string;
    platform: string;
    boundedRaw: string;
    externalEventId: string;
    normalizedKind: string;
    signatureOk: boolean;
  }): Promise<WebhookRecordOutcome> {
    return this.db.withBypass(async (tx) => {
      const eventId = uuidv7();
      const inserted = await tx
        .insert(channelEvents)
        .values({
          id: eventId,
          organizationId: input.orgId,
          channelAccountId: input.accountId,
          platform: input.platform,
          externalEventId: input.externalEventId,
          payload: { raw: input.boundedRaw, normalized_kind: input.normalizedKind, signature_ok: input.signatureOk },
          signatureOk: input.signatureOk,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        // Duplicate redelivery — no second outbox announcement.
        return 'duplicate' as WebhookRecordOutcome;
      }
      await recordOutboxEvent(tx, {
        aggregateType: 'channel_event',
        aggregateId: eventId,
        organizationId: input.orgId,
        eventType: 'channel.event.received',
        eventVersion: 1,
        payload: { channel_account_id: input.accountId, channel_event_id: eventId },
        partitionKey: input.accountId,
      });
      return 'accepted' as WebhookRecordOutcome;
    });
  }

  async getEventByIdForIngest(eventId: string): Promise<ChannelEvent | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(channelEvents).where(eq(channelEvents.id, eventId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async settleEvent(
    eventId: string,
    status: 'processed' | 'quarantined',
    error?: string,
  ): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(channelEvents)
        .set({
          status,
          lastError: error?.slice(0, 1000) ?? null,
          processedAt: new Date().toISOString(),
        })
        .where(eq(channelEvents.id, eventId)),
    );
  }
}
