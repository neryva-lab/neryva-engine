/**
 * MongoDB lane for `IChannelSessionRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. The session/identity plane runs under
 * `withBypass` with explicit filters — exactly the pg lane's scoping
 * (the widget plane authenticates by raw token, not by tenant context).
 * The conversation/run plane reads run through `withOrg`.
 *
 * The token-hash unique index (`uq_channel_sessions_token`) makes a
 * duplicate mint fail closed on both lanes; the token itself is a
 * 192-bit CSPRNG value, so a collision is a correctness bug, not an
 * expected race — both lanes surface it as a hard error.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ChannelSession } from '../schema';
import type { IChannelSessionRepository } from './channel-session.repository';
import { binUuid, channelCollections, isDuplicateKey, toChannelSession } from './mongo-documents';

export class MongoChannelSessionRepository implements IChannelSessionRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...channelCollections(db) };
  }

  async mintSession(input: {
    orgId: string;
    accountId: string;
    sessionId: string;
    identityId: string;
    visitorRef: string;
    tokenHash: string;
    expiresAt: string;
    ipHash: string | null;
    userAgentHash: string | null;
  }): Promise<void> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.identities.unsafeNative.insertOne({
          id: binUuid(input.identityId, 'identityId'),
          organization_id: binUuid(input.orgId, 'orgId'),
          channel_account_id: binUuid(input.accountId, 'accountId'),
          platform: 'web',
          external_user_id: input.visitorRef,
          display_name: null,
          locale: null,
          last_inbound_at: now,
          window_expires_at: null, // no Meta window on web
          retention_class: 'interaction-history',
          created_at: now,
          updated_at: now,
        },
        t.session,
      );
      await t.sessions.unsafeNative.insertOne({
          id: binUuid(input.sessionId, 'sessionId'),
          organization_id: binUuid(input.orgId, 'orgId'),
          channel_account_id: binUuid(input.accountId, 'accountId'),
          identity_id: binUuid(input.identityId, 'identityId'),
          token_hash: input.tokenHash,
          status: 'active',
          expires_at: input.expiresAt,
          last_active_at: now,
          created_ip_hash: input.ipHash,
          user_agent_hash: input.userAgentHash,
          conversation_id: null,
          retention_class: 'interaction-history',
          created_at: now,
        },
        t.session,
      );
    });
  }

  async findSessionByTokenHash(
    accountId: string,
    tokenHash: string,
  ): Promise<ChannelSession | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.sessions.unsafeNative.findOne({
          token_hash: tokenHash,
          channel_account_id: binUuid(accountId, 'accountId'),
        },
        t.session,
      );
      return doc ? toChannelSession(doc) : null;
    });
  }

  async touchSession(sessionId: string, expiresAt: string, lastActiveAt: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.sessions.unsafeNative.updateOne({ id: binUuid(sessionId, 'sessionId') },
        { $set: { expires_at: expiresAt, last_active_at: lastActiveAt } },
        t.session,
      );
    });
  }

  async bindSessionConversation(
    orgId: string,
    sessionId: string,
    conversationId: string,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.sessions.unsafeNative.updateOne({
          id: binUuid(sessionId, 'sessionId'),
          organization_id: binUuid(orgId, 'orgId'),
        },
        { $set: { conversation_id: binUuid(conversationId, 'conversationId') } },
        t.session,
      );
    });
  }

  async getConversationStatus(orgId: string, conversationId: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.conversations.findOne(
        orgId,
        { id: binUuid(conversationId, 'conversationId') },
        t.session,
      );
      return doc?.status ?? null;
    });
  }

  async getRunConversationId(orgId: string, runId: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.runs.findOne(orgId, { id: binUuid(runId, 'runId') }, t.session);
      if (!doc) return null;
      return doc.conversation_id.toUUID().toString();
    });
  }

  async markRecentAssistantMessagesRead(input: {
    orgId: string;
    conversationId: string;
    accountId: string;
  }): Promise<number> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.messages
        .find(
          input.orgId,
          {
            conversation_id: binUuid(input.conversationId, 'conversationId'),
            role: 'assistant',
            superseded_by: null,
          },
          t.session,
        )
        .sort({ sequence: -1 })
        .limit(50)
        .toArray();
      let added = 0;
      for (const doc of docs) {
        try {
          await t.receipts.insertOne(
            input.orgId,
            {
              id: binUuid(uuidv7()),
              organization_id: binUuid(input.orgId, 'orgId'),
              conversation_id: binUuid(input.conversationId, 'conversationId'),
              message_id: doc.id,
              channel_account_id: binUuid(input.accountId, 'accountId'),
              platform: 'web',
              state: 'read',
              occurred_at: now,
              created_at: now,
            },
            t.session,
          );
          added += 1;
        } catch (err) {
          // Receipt already exists for (message, account, state) — the
          // unique index makes this a no-op, same as pg's
          // onConflictDoNothing(). Anything else is a real failure.
          if (!isDuplicateKey(err)) throw err;
        }
      }
      return added;
    });
  }
}
