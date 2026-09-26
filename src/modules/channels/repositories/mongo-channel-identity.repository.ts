/**
 * MongoDB lane for `IChannelIdentityRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Every method is one `withOrg` unit.
 *
 * The upsert mirrors the pg lane's insert-onConflictDoUpdate shape: on a
 * duplicate-key the existing row is re-read (the unique
 * (channel_account_id, external_user_id) index makes concurrent first-inbound
 * races converge on one row). Like the pg lane, the conflict path refreshes
 * only `last_inbound_at`/`window_expires_at`/`updated_at` — display name and
 * locale are set at creation only (original ingest semantics).
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { IChannelIdentityRepository } from './channel-identity.repository';
import { binUuid, channelCollections, isDuplicateKey } from './mongo-documents';

export class MongoChannelIdentityRepository implements IChannelIdentityRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...channelCollections(db) };
  }

  async upsertInboundIdentity(input: {
    orgId: string;
    accountId: string;
    platform: string;
    externalUserId: string;
    displayName: string | null;
    locale: string | null;
    hasWindow: boolean;
  }): Promise<string> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    const windowExpires = input.hasWindow
      ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
      : null;
    const key = {
      channel_account_id: binUuid(input.accountId, 'accountId'),
      external_user_id: input.externalUserId.slice(0, 255),
    };
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        channel_account_id: binUuid(input.accountId, 'accountId'),
        platform: input.platform,
        external_user_id: input.externalUserId.slice(0, 255),
        display_name: input.displayName?.slice(0, 255) ?? null,
        locale: input.locale?.slice(0, 32) ?? null,
        last_inbound_at: now,
        window_expires_at: windowExpires,
        retention_class: 'interaction-history',
        created_at: now,
        updated_at: now,
      };
      try {
        await t.identities.insertOne(input.orgId, doc, t.session);
        return doc.id.toUUID().toString();
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
      // Conflict — refresh only the window/activity fields (pg lane parity),
      // then re-read the winner's id.
      await t.identities.updateOne(
        input.orgId,
        key,
        {
          $set: {
            last_inbound_at: now,
            window_expires_at: windowExpires,
            updated_at: now,
          },
        },
        t.session,
      );
      const winner = await t.identities.findOne(input.orgId, key, t.session);
      if (!winner) {
        throw new Error('channel identity vanished after upsert');
      }
      return winner.id.toUUID().toString();
    });
  }

  async findActiveConversationIdByIdentity(
    orgId: string,
    identityId: string,
  ): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // Cross-module read (documented seam): latest ACTIVE conversation bound
      // to this identity — mirrors the pg lane's raw SQL exactly.
      const docs = await t.conversations
        .find(
          orgId,
          {
            'channel_binding.channel_identity_id': identityId,
            status: 'active',
          },
          t.session,
        )
        .sort({ updated_at: -1 })
        .limit(1)
        .toArray();
      const doc = docs[0];
      return doc ? doc.id.toUUID().toString() : null;
    });
  }

  async getIdentityWindow(
    orgId: string,
    identityId: string,
  ): Promise<{ windowExpiresAt: string | null } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.identities.findOne(
        orgId,
        { id: binUuid(identityId, 'identityId') },
        t.session,
      );
      if (!doc) {
        return null;
      }
      return { windowExpiresAt: doc.window_expires_at ?? null };
    });
  }

  async externalUserIdFor(orgId: string, identityId: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.identities.findOne(
        orgId,
        { id: binUuid(identityId, 'identityId') },
        t.session,
      );
      return doc?.external_user_id ?? null;
    });
  }
}
