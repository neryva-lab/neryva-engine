import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { artifacts, type Artifact } from '../schema';
import type { IArtifactRepository } from './artifact.repository';

/**
 * PostgreSQL implementation of `IArtifactRepository` (P3).
 *
 * Mechanical move of the `ArtifactsService.dereference` artifact read: one
 * `DbService.withOrg` read. No transaction handle leaks through this
 * interface.
 *
 * What stays OUT (still the service's job): the 7 dereference checks,
 * presigned URL minting, input validation, tracing spans.
 */
export class PgArtifactRepository implements IArtifactRepository {
  constructor(private readonly db: DbService) {}

  async findById(orgId: string, artifactId: string): Promise<Artifact | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.organizationId, orgId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }
}
