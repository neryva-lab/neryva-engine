/**
 * MongoDB lane for `IChannelAccountRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings, jsonb columns as subdocuments/plain values.
 * Every method is one `withOrg` unit; the bypass account lookups run
 * through `withBypass` with explicit filters (same scoping as the pg lane).
 *
 * The (organization_id, platform, display_name) duplicate-key is mapped to
 * the same client-facing conflict the pg lane raises.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ChannelAccount } from '../schema';
import type {
  CreateChannelAccountInput,
  IChannelAccountRepository,
  UpdateChannelAccountPatch,
} from './channel-account.repository';
import {
  binUuid,
  channelCollections,
  isDuplicateKey,
  toChannelAccount,
} from './mongo-documents';

export class MongoChannelAccountRepository implements IChannelAccountRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...channelCollections(db) };
  }

  private mapAccountUniqueViolation(err: unknown): never {
    if (isDuplicateKey(err)) {
      throw ApiError.conflict('a channel with this name already exists for this platform');
    }
    throw err as Error;
  }

  async createAccount(input: CreateChannelAccountInput): Promise<ChannelAccount> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const count = await t.accounts.countDocuments(
          input.orgId,
          { status: { $ne: 'suspended' } },
          t.session,
        );
        if (count >= input.cap) {
          throw ApiError.conflict(`channel account cap reached (${input.cap})`, { cap: input.cap });
        }
        const doc = {
          id: binUuid(input.accountId),
          organization_id: binUuid(input.orgId, 'orgId'),
          platform: input.platform,
          display_name: input.displayName,
          public_key: input.publicKey,
          credentials_sealed: input.credentialsSealed,
          verify_token_sealed: input.verifyTokenSealed,
          config: input.config,
          status: 'pending',
          health: null,
          created_by: input.createdBy,
          retention_class: 'interaction-history',
          created_at: now,
          updated_at: now,
        };
        await t.accounts.insertOne(input.orgId, doc, t.session);
        return toChannelAccount({ ...doc, _id: undefined as never });
      });
    } catch (err) {
      this.mapAccountUniqueViolation(err);
    }
  }

  async getAccount(orgId: string, accountId: string): Promise<ChannelAccount | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.accounts.findOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        t.session,
      );
      return doc ? toChannelAccount(doc) : null;
    });
  }

  async getAccountByIdForIngest(accountId: string): Promise<ChannelAccount | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Bypass: the account row resolves the tenant (public webhook path).
      // Uses unsafeNative with an explicit id predicate — the org comes from
      // the row itself, never the request.
      const doc = await t.accounts.unsafeNative.findOne(
        { id: binUuid(accountId, 'accountId') },
        t.session,
      );
      return doc ? toChannelAccount(doc) : null;
    });
  }

  async getAccountByPublicKey(publicKey: string): Promise<ChannelAccount | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Bypass: public-key lookup on the unauthenticated widget path.
      const doc = await t.accounts.unsafeNative.findOne(
        { public_key: publicKey },
        t.session,
      );
      return doc ? toChannelAccount(doc) : null;
    });
  }

  async listAccounts(orgId: string): Promise<ChannelAccount[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.accounts
        .find(orgId, {}, t.session)
        .sort({ updated_at: -1 })
        .limit(200)
        .toArray();
      return docs.map(toChannelAccount);
    });
  }

  async updateAccount(
    orgId: string,
    accountId: string,
    patch: UpdateChannelAccountPatch,
  ): Promise<ChannelAccount> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    try {
      return await this.mongo.withOrg(orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const doc = await t.accounts.findOneAndUpdate(
          orgId,
          { id: binUuid(accountId, 'accountId') },
          {
            $set: {
              ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
              ...(patch.status !== undefined ? { status: patch.status } : {}),
              ...(patch.config !== undefined ? { config: patch.config } : {}),
              updated_at: now,
            },
          },
          { ...t.session, returnDocument: 'after' },
        );
        if (!doc) throw ApiError.notFound('channel account');
        return toChannelAccount(doc);
      });
    } catch (err) {
      this.mapAccountUniqueViolation(err);
    }
  }

  async deactivateAccount(orgId: string, accountId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = new Date().toISOString();
      const updated = await t.accounts.updateOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        {
          $set: {
            status: 'suspended',
            credentials_sealed: {},
            verify_token_sealed: null,
            updated_at: now,
          },
        },
        t.session,
      );
      if (updated.matchedCount === 0) throw ApiError.notFound('channel account');
      // Widget sessions die with the account.
      await t.sessions.updateMany(
        orgId,
        { channel_account_id: binUuid(accountId, 'accountId') },
        { $set: { status: 'revoked', expires_at: now } },
        t.session,
      );
    });
  }

  async rotateCredentials(
    orgId: string,
    accountId: string,
    input: {
      credentialsSealed: Record<string, string>;
      verifyTokenSealed: string | null;
      reverify: boolean;
    },
  ): Promise<ChannelAccount> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.accounts.findOneAndUpdate(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        {
          $set: {
            credentials_sealed: input.credentialsSealed,
            ...(input.verifyTokenSealed ? { verify_token_sealed: input.verifyTokenSealed } : {}),
            ...(input.reverify ? { status: 'pending', health: { last_verified: null } } : {}),
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!doc) throw ApiError.notFound('channel account');
      return toChannelAccount(doc);
    });
  }

  async setHealth(
    orgId: string,
    accountId: string,
    input: { health: Record<string, unknown>; markActive: boolean },
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.accounts.updateOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        {
          $set: {
            health: input.health,
            ...(input.markActive ? { status: 'active' } : {}),
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
    });
  }
}
