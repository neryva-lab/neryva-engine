/**
 * MongoDB implementation of the connector-document-tombstone repository port
 * (P3) — source-deletion propagation for connector syncs.
 *
 * A retired document is unreachable by retrieval; deleting its source ACLs
 * removes the last allow-list that could admit it.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  ConnectorDocumentMongoDoc,
  DocumentMongoDoc,
  DocumentSourceAclMongoDoc,
} from './mongo-documents';
import type { IConnectorDocumentTombstoneRepository } from './connector-document-tombstone.repository';
import { binUuid, nowIso, sessionOf } from './mongo-knowledge-shared';

const CONNECTOR_DOCUMENTS = 'connector_documents';
const DOCUMENTS = 'documents';
const DOCUMENT_SOURCE_ACLS = 'document_source_acls';

export class MongoConnectorDocumentTombstoneRepository
  implements IConnectorDocumentTombstoneRepository
{
  constructor(private readonly mongo: MongoDbService) {}

  async lookupDocumentId(
    orgId: string,
    accountId: string,
    externalId: string,
  ): Promise<string | null> {
    const db = this.mongo.root;
    // Its own transaction, matching today's split — a cheap pre-check
    // callers make before deciding to act.
    return this.mongo.withOrg(orgId, async (ctx) => {
      const map = new TenantScopedCollection<ConnectorDocumentMongoDoc>(
        db.collection(CONNECTOR_DOCUMENTS),
      );
      const doc = await map.findOne(
        orgId,
        {
          connector_account_id: binUuid(accountId, 'accountId'),
          external_id: externalId,
        },
        { ...sessionOf(ctx), projection: { document_id: 1 } },
      );
      return doc ? doc.document_id.toUUID().toString() : null;
    });
  }

  async tombstoneByExternalId(
    orgId: string,
    accountId: string,
    externalId: string,
  ): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const map = new TenantScopedCollection<ConnectorDocumentMongoDoc>(
        db.collection(CONNECTOR_DOCUMENTS),
      );
      const documents = new TenantScopedCollection<DocumentMongoDoc>(db.collection(DOCUMENTS));
      const acls = new TenantScopedCollection<DocumentSourceAclMongoDoc>(
        db.collection(DOCUMENT_SOURCE_ACLS),
      );
      const s = sessionOf(ctx);

      const mapped = await map.findOne(
        orgId,
        {
          connector_account_id: binUuid(accountId, 'accountId'),
          external_id: externalId,
        },
        { ...s, projection: { document_id: 1 } },
      );
      // Unmapped external id — nothing to tombstone, not an error.
      if (!mapped) return false;

      await documents.updateOne(
        orgId,
        { id: mapped.document_id },
        { $set: { state: 'retired', updated_at: nowIso() } },
        s,
      );
      await acls.deleteMany(orgId, { document_id: mapped.document_id }, s);
      return true;
    });
  }
}
