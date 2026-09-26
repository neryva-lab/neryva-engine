import { DbService } from '../../../common/infra/db/db.service';
import { artifacts, uploadSessions } from '../schema';
import type { IConnectorIngestStagingRepository } from './connector-ingest-staging.repository';
import type { StagedSourceDocument } from './repository-types';

/**
 * PostgreSQL implementation of `IConnectorIngestStagingRepository` (P3).
 *
 * Mechanical move of the `ingestConnectorDocument` staging write from
 * `ConnectorsService`: one `DbService.withOrg` transaction inserting the
 * artifact + the UPLOADED upload session. Both inserts commit together (an
 * artifact without its session is unclaimable; a session without its
 * artifact violates the FK). No transaction handle leaks.
 *
 * What stays OUT (still the service's job): fetching bytes from the
 * external source (network), minting the tenant-bound object key and
 * uploading to object storage, the mapping-aware target lookup (the
 * session's `targetDocumentId` arrives on the draft), the source-ACL intent
 * (carried on the draft's session row).
 */
export class PgConnectorIngestStagingRepository implements IConnectorIngestStagingRepository {
  constructor(private readonly db: DbService) {}

  async stageDocument(orgId: string, draft: StagedSourceDocument): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.insert(artifacts).values(draft.artifact);
      await tx.insert(uploadSessions).values(draft.session);
    });
  }
}
