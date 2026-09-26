/**
 * MongoDB lane for `IChannelMessageLinkRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Every method is one `withOrg` unit matching
 * the pg lane's scoping (inbound links use withOrg — the org is known from
 * the account; the pg lane's recordInboundLink runs in withBypass only
 * because it shared the consumer's outer bypass tx, which this lane does
 * not have).
 *
 * Inbound dedup mirrors the pg lane's onConflictDoNothing: a duplicate-key
 * on (channel_account_id, external_message_id) is swallowed. The outbound
 * claim is insert-or-read-existing, matching the pg lane's atomic
 * insert-onConflictDoNothing-then-select.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  IChannelMessageLinkRepository,
  OutboundBinding,
} from './channel-message-link.repository';
import {
  binUuid,
  channelCollections,
  isDuplicateKey,
  toChannelAccount,
  toChannelMessageLink,
} from './mongo-documents';

export class MongoChannelMessageLinkRepository implements IChannelMessageLinkRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...channelCollections(db) };
  }

  async recordInboundLink(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    platform: string;
    externalMessageId: string | null;
  }): Promise<void> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      try {
        await t.messageLinks.insertOne(
          input.orgId,
          {
            id: binUuid(uuidv7(), 'linkId'),
            organization_id: binUuid(input.orgId, 'orgId'),
            conversation_id: binUuid(input.conversationId, 'conversationId'),
            message_id: binUuid(input.messageId, 'messageId'),
            channel_account_id: binUuid(input.accountId, 'accountId'),
            direction: 'inbound',
            platform: input.platform,
            external_message_id: input.externalMessageId?.slice(0, 255) ?? null,
            delivery_state: 'sent',
            provider_error: null,
            retention_class: 'interaction-history',
            created_at: now,
            updated_at: now,
          },
          t.session,
        );
      } catch (err) {
        // Redelivered inbound — the pg lane's onConflictDoNothing.
        if (!isDuplicateKey(err)) throw err;
      }
    });
  }

  async applyStatusEvent(input: {
    orgId: string;
    accountId: string;
    externalMessageId: string;
    status: string;
    providerError: { code: string; message: string | null } | null;
    occurredAtMs?: number;
  }): Promise<void> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const link = await t.messageLinks.findOne(
        input.orgId,
        {
          channel_account_id: binUuid(input.accountId, 'accountId'),
          external_message_id: input.externalMessageId,
        },
        t.session,
      );
      if (!link) {
        return;
      }
      await t.messageLinks.updateOne(
        input.orgId,
        { id: link.id },
        {
          $set: {
            delivery_state: input.status,
            provider_error: input.providerError,
            updated_at: now,
          },
        },
        t.session,
      );
      // Delivery/read receipts are OUTBOUND only (pg lane parity). First
      // platform report wins — duplicate-key on (message, account, state)
      // is swallowed, matching the pg onConflictDoNothing.
      if (link.direction === 'outbound' && (input.status === 'delivered' || input.status === 'read')) {
        try {
          await t.receipts.insertOne(
            input.orgId,
            {
              id: binUuid(uuidv7(), 'receiptId'),
              organization_id: binUuid(input.orgId, 'orgId'),
              conversation_id: link.conversation_id,
              message_id: link.message_id,
              channel_account_id: link.channel_account_id,
              platform: link.platform,
              state: input.status,
              occurred_at: input.occurredAtMs ? new Date(input.occurredAtMs).toISOString() : now,
              created_at: now,
            },
            t.session,
          );
        } catch (err) {
          if (!isDuplicateKey(err)) throw err;
        }
      }
    });
  }

  async claimOutboundLink(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    platform: string;
  }): Promise<{ claimed: boolean; existingState: string | null }> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      try {
        await t.messageLinks.insertOne(
          input.orgId,
          {
            id: binUuid(uuidv7(), 'linkId'),
            organization_id: binUuid(input.orgId, 'orgId'),
            conversation_id: binUuid(input.conversationId, 'conversationId'),
            message_id: binUuid(input.messageId, 'messageId'),
            channel_account_id: binUuid(input.accountId, 'accountId'),
            direction: 'outbound',
            platform: input.platform,
            external_message_id: null,
            delivery_state: 'pending',
            provider_error: null,
            retention_class: 'interaction-history',
            created_at: now,
            updated_at: now,
          },
          t.session,
        );
        return { claimed: true, existingState: null };
      } catch (err) {
        // Lost the claim race — return the existing state so the caller can
        // apply the sent/delivered/read skip vs pending re-send policy.
        if (!isDuplicateKey(err)) throw err;
        const existing = await t.messageLinks.findOne(
          input.orgId,
          { message_id: binUuid(input.messageId, 'messageId') },
          t.session,
        );
        return { claimed: false, existingState: existing?.delivery_state ?? null };
      }
    });
  }

  async markLinkSent(
    orgId: string,
    messageId: string,
    externalMessageId: string | null,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.messageLinks.updateOne(
        orgId,
        { message_id: binUuid(messageId, 'messageId') },
        {
          $set: {
            delivery_state: 'sent',
            external_message_id: externalMessageId?.slice(0, 255) ?? null,
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }

  async markLinkState(
    orgId: string,
    messageId: string,
    state: 'skipped' | 'failed',
    reason: Record<string, unknown> | null,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.messageLinks.updateOne(
        orgId,
        { message_id: binUuid(messageId, 'messageId') },
        {
          $set: {
            delivery_state: state,
            provider_error: reason,
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }

  async loadOutboundMessage(
    orgId: string,
    messageId: string,
  ): Promise<{ id: string; content: unknown } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.messages.findOne(
        orgId,
        { id: binUuid(messageId, 'messageId') },
        t.session,
      );
      if (!doc) {
        return null;
      }
      return { id: doc.id.toUUID().toString(), content: doc.content };
    });
  }

  async loadOutboundBinding(orgId: string, conversationId: string): Promise<OutboundBinding | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const conv = await t.conversations.findOne(
        orgId,
        { id: binUuid(conversationId, 'conversationId') },
        t.session,
      );
      const binding = conv?.channel_binding as
        | { platform?: string; channel_account_id?: string; channel_identity_id?: string }
        | null
        | undefined;
      const accountId = binding?.channel_account_id;
      if (!conv || !binding?.platform || !accountId) {
        return null;
      }
      const accountDoc = await t.accounts.findOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        t.session,
      );
      if (!accountDoc || accountDoc.status === 'suspended') {
        return null;
      }
      const account = toChannelAccount(accountDoc as Parameters<typeof toChannelAccount>[0]);
      return {
        conversationId: conv.id.toUUID().toString(),
        account,
        binding: {
          ...(binding.platform ? { platform: binding.platform } : {}),
          channel_account_id: accountId,
          ...(binding.channel_identity_id ? { channel_identity_id: binding.channel_identity_id } : {}),
        },
      };
    });
  }

  async loadOutboundArtifact(
    orgId: string,
    artifactId: string,
  ): Promise<{ id: string; objectKey: string; state: string; purpose: string } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.artifacts.findOne(
        orgId,
        { id: binUuid(artifactId, 'artifactId'), deleted_at: null },
        t.session,
      );
      if (!doc) {
        return null;
      }
      return {
        id: doc.id.toUUID().toString(),
        objectKey: doc.object_key,
        state: doc.state,
        purpose: doc.purpose,
      };
    });
  }
}
