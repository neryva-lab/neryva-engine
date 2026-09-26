/**
 * MongoDB implementation of the connector-OAuth-app repository port (P3).
 *
 * The sealed client secret (`enc:v1:` envelope) stays OPAQUE: it is stored
 * and returned sealed, never decrypted by this repository.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { ConnectorOAuthApp } from './repository-types';
import type { ConnectorOAuthAppMongoDoc } from './mongo-documents';
import type { IConnectorOAuthAppRepository } from './connector-oauth-app.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  newId,
  nowIso,
  sessionOf,
} from './mongo-knowledge-shared';

const CONNECTOR_OAUTH_APPS = 'connector_oauth_apps';

function toOAuthApp(doc: ConnectorOAuthAppMongoDoc, orgId: string): ConnectorOAuthApp {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: orgId,
    provider: doc.provider,
    clientId: doc.client_id,
    clientSecretSealed: doc.client_secret_sealed,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class MongoConnectorOAuthAppRepository implements IConnectorOAuthAppRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async upsertApp(
    orgId: string,
    input: { provider: string; clientId: string; clientSecretSealed: string; createdBy: string },
  ): Promise<{ id: string; provider: string }> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const apps = new TenantScopedCollection<ConnectorOAuthAppMongoDoc>(
        db.collection(CONNECTOR_OAUTH_APPS),
      );
      const now = nowIso();
      // Mirrors INSERT … ON CONFLICT (org, provider) DO UPDATE: the caller's
      // createdBy seeds only the insert side; the conflict side rewrites the
      // client id + sealed secret and bumps updated_at.
      const doc = await apps.findOneAndUpdate(
        orgId,
        { provider: input.provider },
        {
          $setOnInsert: {
            id: binUuid(newId()),
            created_by: input.createdBy,
            created_at: now,
          },
          $set: {
            client_id: input.clientId,
            client_secret_sealed: input.clientSecretSealed,
            updated_at: now,
          },
        },
        { ...sessionOf(ctx), upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new Error('mongo repository: connector OAuth app upsert returned no row');
      return { id: doc.id.toUUID().toString(), provider: doc.provider };
    });
  }

  async listApps(orgId: string): Promise<ConnectorOAuthApp[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const apps = new TenantScopedCollection<ConnectorOAuthAppMongoDoc>(
        db.collection(CONNECTOR_OAUTH_APPS),
      );
      const docs = await apps
        .find(orgId, {}, { ...sessionOf(ctx), sort: { provider: 1 } })
        .toArray();
      return docs.map((d) => toOAuthApp(d, orgId));
    });
  }

  async findApp(orgId: string, provider: string): Promise<ConnectorOAuthApp | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const apps = new TenantScopedCollection<ConnectorOAuthAppMongoDoc>(
        db.collection(CONNECTOR_OAUTH_APPS),
      );
      const doc = await apps.findOne(orgId, { provider }, sessionOf(ctx));
      return doc ? toOAuthApp(doc, orgId) : null;
    });
  }

  async deleteApp(orgId: string, provider: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const apps = new TenantScopedCollection<ConnectorOAuthAppMongoDoc>(
        db.collection(CONNECTOR_OAUTH_APPS),
      );
      // Idempotent — no row, no error.
      await apps.deleteOne(orgId, { provider }, sessionOf(ctx));
    });
  }
}
