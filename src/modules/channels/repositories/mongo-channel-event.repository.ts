/**
 * MongoDB lane for `IChannelEventRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. The webhook receipt is ONE `withOrg` unit —
 * envelope insert + `channel.event.received` outbox append — mirroring the
 * pg lane's same-transaction invariant (invariant 7).
 *
 * Tenant scoping: the org is explicit — the ingest service resolves the
 * account (bypass read) and passes `account.organizationId` before calling
 * this repository. `withOrg(input.orgId)` keeps the envelope write AND the
 * outbox write tenant-bound, which `MongoOutboxStore.append` requires
 * (fail-closed outside a tenant context). The pg lane runs the same body
 * under `withBypass` with the same explicit `organization_id` value, so
 * both lanes persist identical tenant scoping.
 *
 * The (channel_account_id, external_event_id) duplicate-key maps to the
 * same `duplicate` no-op the pg lane returns from its
 * onConflictDoNothing().returning() shape — never a second outbox event.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ChannelEvent } from '../schema';
import type { IChannelEventRepository, WebhookRecordOutcome } from './channel-event.repository';
import {
  binUuid,
  channelCollections,
  isDuplicateKey,
  toChannelEvent,
} from './mongo-documents';

export class MongoChannelEventRepository implements IChannelEventRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...channelCollections(db) };
  }

  async recordWebhookEvent(input: {
    accountId: string;
    orgId: string;
    platform: string;
    boundedRaw: string;
    externalEventId: string;
    normalizedKind: string;
    signatureOk: boolean;
  }): Promise<WebhookRecordOutcome> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    try {
      await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const eventId = uuidv7();
        const doc = {
          id: binUuid(eventId),
          organization_id: binUuid(input.orgId, 'orgId'),
          channel_account_id: binUuid(input.accountId, 'accountId'),
          platform: input.platform,
          external_event_id: input.externalEventId,
          payload: { raw: input.boundedRaw, normalized_kind: input.normalizedKind, signature_ok: input.signatureOk },
          signature_ok: input.signatureOk,
          status: 'received',
          last_error: null,
          received_at: now,
          processed_at: null,
          retention_class: 'interaction-history',
        };
        await t.events.insertOne(input.orgId, doc, t.session);
        // Same outbox contract as the pg lane: organizationId is NOT NULL,
        // payload carries only what ChannelIngestConsumer reads.
        const outbox = new MongoOutboxStore(db, ctx);
        await outbox.append({
          aggregateType: 'channel_event',
          aggregateId: eventId,
          organizationId: input.orgId,
          eventType: 'channel.event.received',
          eventVersion: 1,
          payload: { channel_account_id: input.accountId, channel_event_id: eventId },
          partitionKey: input.accountId,
        });
      });
      return 'accepted';
    } catch (err) {
      // Redelivery race — the unique (channel_account_id, external_event_id)
      // key makes the second insert a no-op, exactly like pg's
      // onConflictDoNothing(). Never a second outbox event.
      if (isDuplicateKey(err)) return 'duplicate';
      throw err;
    }
  }

  async getEventByIdForIngest(eventId: string): Promise<ChannelEvent | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Bypass: the outbox worker resolves by exact id from a trusted event.
      const doc = await t.events.unsafeNative.findOne(
        { id: binUuid(eventId, 'eventId') },
        t.session,
      );
      return doc ? toChannelEvent(doc) : null;
    });
  }

  async settleEvent(
    eventId: string,
    status: 'processed' | 'quarantined',
    error?: string,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Bypass: settlement by exact id (the worker owns the event lifecycle).
      await t.events.unsafeNative.updateOne(
        { id: binUuid(eventId, 'eventId') },
        {
          $set: {
            status,
            last_error: error?.slice(0, 1000) ?? null,
            processed_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }
}
