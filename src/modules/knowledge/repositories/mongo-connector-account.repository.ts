/**
 * MongoDB implementation of the connector-account repository port (P3).
 *
 * Sealed envelopes (`{ v: string }`) stay OPAQUE: this repository never
 * decrypts credentials. Anti-stale-snapshot: one method per use, each
 * re-reads the row fresh — no caching of sealed bundles.
 */
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { ConnectorAccount } from './repository-types';
import type { ConnectorAccountMongoDoc } from './mongo-documents';
import type { IConnectorAccountRepository } from './connector-account.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  nowIso,
  sessionOf,
} from './mongo-knowledge-shared';

const CONNECTOR_ACCOUNTS = 'connector_accounts';

function toConnectorAccount(doc: ConnectorAccountMongoDoc, orgId: string): ConnectorAccount {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: orgId,
    provider: doc.provider,
    displayName: doc.display_name,
    config: (doc.config ?? {}) as ConnectorAccount['config'],
    credentialsSealed: (doc.credentials_sealed ?? null) as ConnectorAccount['credentialsSealed'],
    state: doc.state,
    cursor: (doc.cursor ?? {}) as ConnectorAccount['cursor'],
    lastSyncedAt: doc.last_synced_at,
    lastError: doc.last_error,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class MongoConnectorAccountRepository implements IConnectorAccountRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async upsertAccount(
    orgId: string,
    input: {
      id: string;
      provider: string;
      displayName: string;
      config: Record<string, unknown>;
      credentialsSealed: { v: string } | null;
      createdBy: string;
    },
  ): Promise<ConnectorAccount> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      const now = nowIso();
      // Mirrors INSERT … ON CONFLICT (org, provider, display_name) DO
      // UPDATE: the caller's `id`/`createdBy` seed only the insert side;
      // conflict side rewrites config (+ the sealed bundle when supplied),
      // flips state back to active and bumps updated_at. Never clears
      // credentials it was not given.
      const set: Record<string, unknown> = {
        config: input.config,
        state: 'active',
        updated_at: now,
      };
      if (input.credentialsSealed) set.credentials_sealed = input.credentialsSealed;
      // `credentials_sealed` must not appear in both $set and $setOnInsert
      // (MongoDB rejects the conflicting paths); the insert side only
      // seeds null when the caller did not supply a bundle.
      const setOnInsert: Record<string, unknown> = {
        id: binUuid(input.id, 'id'),
        created_by: input.createdBy,
        created_at: now,
        cursor: {},
        last_synced_at: null,
        last_error: null,
      };
      if (!input.credentialsSealed) setOnInsert.credentials_sealed = null;
      const doc = await accounts.findOneAndUpdate(
        orgId,
        { provider: input.provider, display_name: input.displayName },
        { $setOnInsert: setOnInsert, $set: set },
        { ...sessionOf(ctx), upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new Error('mongo repository: connector account upsert returned no row');
      return toConnectorAccount(doc, orgId);
    });
  }

  async findById(orgId: string, accountId: string): Promise<ConnectorAccount | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      const doc = await accounts.findOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        sessionOf(ctx),
      );
      return doc ? toConnectorAccount(doc, orgId) : null;
    });
  }

  async listAccounts(orgId: string): Promise<ConnectorAccount[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      const docs = await accounts
        .find(orgId, {}, { ...sessionOf(ctx), sort: { display_name: 1 } })
        .toArray();
      return docs.map((d) => toConnectorAccount(d, orgId));
    });
  }

  async updateState(
    orgId: string,
    accountId: string,
    state: 'active' | 'paused' | 'error',
    lastError: string | null,
  ): Promise<ConnectorAccount> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      // Missing account is a caller bug — notFound, not a silent no-op.
      const doc = await accounts.findOneAndUpdate(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        { $set: { state, last_error: lastError, updated_at: nowIso() } },
        { ...sessionOf(ctx), returnDocument: 'after' },
      );
      if (!doc) throw ApiError.notFound('connector account');
      return toConnectorAccount(doc, orgId);
    });
  }

  async persistCredentialBundle(
    orgId: string,
    accountId: string,
    bundleSealed: { v: string },
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      // UNCONDITIONAL last-writer-wins update — deliberately no
      // compare-and-set: credential rotation and the OAuth refresh race both
      // write the freshest bundle they hold, and a CAS would turn a benign
      // race into a failed refresh.
      await accounts.updateOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        { $set: { credentials_sealed: bundleSealed, updated_at: nowIso() } },
        sessionOf(ctx),
      );
    });
  }

  async updateCursor(
    orgId: string,
    accountId: string,
    cursor: Record<string, unknown>,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      // Successful sync clears the error posture it replaces.
      await accounts.updateOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        {
          $set: {
            cursor,
            last_synced_at: nowIso(),
            state: 'active',
            last_error: null,
            updated_at: nowIso(),
          },
        },
        sessionOf(ctx),
      );
    });
  }

  async recordSyncError(orgId: string, accountId: string, message: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const accounts = new TenantScopedCollection<ConnectorAccountMongoDoc>(
        db.collection(CONNECTOR_ACCOUNTS),
      );
      await accounts.updateOne(
        orgId,
        { id: binUuid(accountId, 'accountId') },
        {
          $set: {
            state: 'error',
            last_error: message.slice(0, 512),
            updated_at: nowIso(),
          },
        },
        sessionOf(ctx),
      );
    });
  }

  async findDueActiveAccounts(providers: string[], limit: number): Promise<ConnectorAccount[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      // BYPASS: the sync scheduler enumerates due accounts across orgs and
      // re-scopes per account before acting.
      // PostgreSQL `ORDER BY last_synced_at ASC` sorts NULLS LAST; mongo
      // sorts nulls first, so nulls are pushed behind via a sort key.
      const docs = await db
        .collection<ConnectorAccountMongoDoc>(CONNECTOR_ACCOUNTS)
        .aggregate<ConnectorAccountMongoDoc>(
          [
            { $match: { state: 'active', provider: { $in: providers } } },
            { $addFields: { __sync: { $ifNull: ['$last_synced_at', '9999-12-31T23:59:59.999Z'] } } },
            { $sort: { __sync: 1 } },
            { $limit: Math.max(limit, 0) },
            { $project: { __sync: 0 } },
          ],
          sessionOf(ctx),
        )
        .toArray();
      return docs.map((d) => toConnectorAccount(d, d.organization_id.toUUID().toString()));
    });
  }
}
