/**
 * MongoDB implementation of the artifact repository port (P3) — the read
 * side of the artifact lifecycle (`ArtifactsService`, claim-check facade).
 *
 * The interface is intentionally narrow: artifact lifecycle writes live in
 * `IUploadSessionRepository` / `IConnectorIngestStagingRepository`. This
 * port owns exactly one method, `findById`, run withOrg with an explicit
 * `organization_id` predicate (plan D6). UUIDs are BSON Binary subtype 4.
 */
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { Artifact } from '../schema';
import type { ArtifactMongoDoc } from './mongo-documents';
import type { IArtifactRepository } from './artifact.repository';
import {
  binUuid,
  ensureKnowledgeIndexes,
  sessionOf,
  toArtifactRow,
  txCollection,
} from './mongo-knowledge-shared';

const ARTIFACTS = 'artifacts';

export class MongoArtifactRepository implements IArtifactRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async findById(orgId: string, artifactId: string): Promise<Artifact | null> {
    const db = this.mongo.root;
    await ensureKnowledgeIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const artifacts = txCollection<ArtifactMongoDoc>(db, ARTIFACTS);
      const doc = await artifacts.findOne(
        orgId,
        { id: binUuid(artifactId, 'artifactId') },
        sessionOf(ctx),
      );
      return doc ? toArtifactRow(doc) : null;
    });
  }
}
