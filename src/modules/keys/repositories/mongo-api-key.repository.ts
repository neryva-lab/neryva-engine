import type { Db, Filter } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  ApiKeyCreateInput,
  ApiKeyEventRow,
  ApiKeyPatch,
  ApiKeyRow,
  ExpiringApiKeyRow,
  IApiKeyRepository,
} from './keys.repository';
import {
  binUuid,
  ensureKeysIndexes,
  isDuplicateKey,
  tenantCollection,
  toApiKeyEventRow,
  toApiKeyRow,
  toExpiringApiKeyRow,
} from './mongo-documents';
import type {
  ApiKeyMongoDoc,
  ExpiringApiKeyMongoDoc,
  KeyEventMongoDoc,
} from './mongo-documents';

/**
 * MongoDB lane for `IApiKeyRepository` (P3) — the `api_keys` row lifecycle
 * as driven by `KeysService`.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every tenant
 * method is one `withOrg` unit (plan D5); the tenant predicate is enforced
 * by `TenantScopedCollection` on the `tenant_id` field (plan D6).
 *
 * The three bypass operations (`findByKeyHash`, `scanExpiringKeys`,
 * `listKeyEvents`) run on `withBypass` with explicit predicates and no
 * tenant field — the tenant is unknowable (`findByKeyHash`, `listKeyEvents`)
 * or cross-org by design (`scanExpiringKeys`), mirroring the pg lane's
 * `withBypass`.
 */
export class MongoApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    apiKeys: TenantScopedCollection<ApiKeyMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      apiKeys: tenantCollection<ApiKeyMongoDoc>(db, 'api_keys', { tenantField: 'tenant_id' }),
    };
  }

  async listKeys(orgId: string): Promise<ApiKeyRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.apiKeys
        .find(orgId, {}, t.session)
        .sort({ created_at: -1 })
        .limit(200)
        .toArray();
      return rows.map(toApiKeyRow);
    });
  }

  async getKey(orgId: string, keyId: string): Promise<ApiKeyRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.apiKeys.findOne(
        orgId,
        { id: binUuid(keyId, 'keyId') },
        t.session,
      );
      return row ? toApiKeyRow(row) : null;
    });
  }

  async createKey(input: ApiKeyCreateInput): Promise<{ id: string }> {
    const db = this.mongo.root;
    await ensureKeysIndexes(db);
    const now = input.createdAt;
    try {
      await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        // Mongo does not apply the pg column defaults — every field is set
        // explicitly here.
        const doc: ApiKeyMongoDoc = {
          id: binUuid(input.id),
          name: input.name,
          key_hash: input.keyHash,
          prefix: input.prefix,
          role: input.role,
          tenant_id: binUuid(input.orgId, 'orgId'),
          scopes: input.scopes,
          expires_at: input.expiresAt,
          revoked: false,
          last_used_at: null,
          usage_count: 0,
          mfa_secret: null,
          mfa_enabled: false,
          created_at: now,
          updated_at: input.updatedAt,
        };
        await t.apiKeys.insertOne(input.orgId, doc, t.session);
      });
    } catch (err) {
      // The duplicate-key catch sits OUTSIDE the transaction: a 11000
      // aborts its transaction, and any follow-up work on that session
      // raises NoSuchTransaction. The pg lane's 23505 maps to the same
      // `conflict`.
      if (isDuplicateKey(err)) {
        throw ApiError.conflict('api key hash already in use', { reason: 'duplicate_key_hash' });
      }
      throw err;
    }
    return { id: input.id };
  }

  async revokeKey(orgId: string, keyId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.apiKeys.findOne(orgId, { id: binUuid(keyId, 'keyId') }, t.session);
      if (!row) throw ApiError.notFound('api key');
      await t.apiKeys.updateOne(
        orgId,
        { id: binUuid(keyId, 'keyId') },
        { $set: { revoked: true, updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async updateKey(orgId: string, keyId: string, patch: ApiKeyPatch): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.apiKeys.findOne(orgId, { id: binUuid(keyId, 'keyId') }, t.session);
      if (!row || row.revoked) throw ApiError.notFound('api key');
      const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.scopes !== undefined) set.scopes = patch.scopes;
      await t.apiKeys.updateOne(
        orgId,
        { id: binUuid(keyId, 'keyId') },
        { $set: set },
        t.session,
      );
    });
  }

  async rotateKey(
    orgId: string,
    keyId: string,
    input: { keyHash: string; prefix: string },
  ): Promise<ApiKeyRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.apiKeys.findOne(orgId, { id: binUuid(keyId, 'keyId') }, t.session);
      if (!row || row.revoked) throw ApiError.notFound('api key');
      await t.apiKeys.updateOne(
        orgId,
        { id: binUuid(keyId, 'keyId') },
        {
          $set: {
            key_hash: input.keyHash,
            prefix: input.prefix,
            usage_count: 0,
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
      return toApiKeyRow(row);
    });
  }

  /**
   * UNAUTHENTICATED auth path. Bypass is safe: the key hash IS the
   * credential and the tenant is unknowable before the read — the org
   * comes from the row's `tenant_id`. Single query (latency-sensitive).
   */
  async findByKeyHash(keyHash: string): Promise<ApiKeyRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const doc = await db
        .collection<ApiKeyMongoDoc>('api_keys')
        .findOne({ key_hash: keyHash }, { session: ctx.session });
      return doc ? toApiKeyRow(doc) : null;
    });
  }

  /**
   * Bypass scan for the daily expiring-key worker. Bypass is safe: the scan
   * is cross-org by design (each key's own org is notified) and filters
   * only on `revoked`/`expires_at`. `expires_at: null` is excluded
   * explicitly — MongoDB's `$lte` on a string WOULD match null/missing
   * (null sorts before everything), while the pg lane's `<=` never does
   * (SQL three-valued logic).
   */
  async scanExpiringKeys(horizonIso: string): Promise<ExpiringApiKeyRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const filter: Filter<ApiKeyMongoDoc> = {
        revoked: false,
        expires_at: { $ne: null, $lte: horizonIso },
      };
      const docs = await db
        .collection<ApiKeyMongoDoc>('api_keys')
        .find(filter, { session: ctx.session })
        .project<ExpiringApiKeyMongoDoc>({ id: 1, name: 1, tenant_id: 1, expires_at: 1 })
        .toArray();
      return docs.map(toExpiringApiKeyRow);
    });
  }

  /**
   * The key.* audit-trail read. Bypass is safe: `audit_events` is
   * platform-plane (the pg lane reads it via `withBypass`), and the
   * predicate `(resource_id, action LIKE 'key.%')` names the key directly.
   */
  async listKeyEvents(keyId: string): Promise<ApiKeyEventRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await db
        .collection<KeyEventMongoDoc>('audit_events')
        .find(
          { resource_id: keyId, action: { $regex: '^key\\.' } },
          { session: ctx.session },
        )
        .project<KeyEventMongoDoc>({ action: 1, actor_id: 1, created_at: 1, details: 1 })
        .sort({ created_at: -1 })
        .limit(50)
        .toArray();
      return docs.map(toApiKeyEventRow);
    });
  }
}
