import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { connectorDocuments } from '../connectors.schema';
import { documents, documentSourceAcls } from '../schema';
import type { IConnectorDocumentTombstoneRepository } from './connector-document-tombstone.repository';

/**
 * PostgreSQL implementation of `IConnectorDocumentTombstoneRepository` (P3).
 *
 * Mechanical move of the `tombstoneExternalDocument` SQL from
 * `ConnectorsService`. Each method owns its transaction; no transaction
 * handle leaks.
 *
 * When a connector source deletes a document, the sync names the external
 * id; the `connector_documents` map resolves it to the engine document, and
 * the document is retired plus its source ACLs removed so retrieval can
 * never admit it again. The mapping row is KEPT (it drives re-sync
 * versioning — a re-appearing external id appends a version, never a
 * duplicate).
 */
export class PgConnectorDocumentTombstoneRepository implements IConnectorDocumentTombstoneRepository {
  constructor(private readonly db: DbService) {}

  async lookupDocumentId(orgId: string, accountId: string, externalId: string): Promise<string | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ documentId: connectorDocuments.documentId })
        .from(connectorDocuments)
        .where(
          and(
            eq(connectorDocuments.organizationId, orgId),
            eq(connectorDocuments.connectorAccountId, accountId),
            eq(connectorDocuments.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0]?.documentId ?? null;
    });
  }

  async tombstoneByExternalId(orgId: string, accountId: string, externalId: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (tx) => {
      const mapped = await tx
        .select({ documentId: connectorDocuments.documentId })
        .from(connectorDocuments)
        .where(
          and(
            eq(connectorDocuments.organizationId, orgId),
            eq(connectorDocuments.connectorAccountId, accountId),
            eq(connectorDocuments.externalId, externalId),
          ),
        )
        .limit(1);
      if (!mapped[0]) {
        return false;
      }
      await tx
        .update(documents)
        .set({ state: 'retired', updatedAt: new Date().toISOString() })
        .where(eq(documents.id, mapped[0].documentId));
      await tx.delete(documentSourceAcls).where(eq(documentSourceAcls.documentId, mapped[0].documentId));
      return true;
    });
  }
}
