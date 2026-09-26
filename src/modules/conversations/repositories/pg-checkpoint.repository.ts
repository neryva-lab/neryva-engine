/**
 * PostgreSQL checkpoint repository (P3) — run checkpoints (ledger §5.8).
 *
 * Mechanical move of the `McpAuthorityService` checkpoint units
 * (`saveCheckpointRef`, `getLatestCheckpoint`). Checkpoints are claim-check
 * pointers only; the artifact bytes they reference are registered through
 * `IArtifactRepository`.
 */
import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { checkpoints } from '../mcp.schema';
import { artifacts } from '../../knowledge/schema';
import type { CheckpointData, ICheckpointRepository } from './checkpoint.repository';

export class PgCheckpointRepository implements ICheckpointRepository {
  constructor(private readonly db: DbService) {}

  async saveCheckpointRef(input: {
    orgId: string;
    runId: string;
    checkpointRef: string;
    checkpointVersion: number;
    artifactId?: string;
    digest: Buffer;
    producer: string;
  }): Promise<{ accepted: boolean; replay: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const existing = await tx
        .select()
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.runId, input.runId),
            eq(checkpoints.checkpointRef, input.checkpointRef),
            eq(checkpoints.checkpointVersion, input.checkpointVersion),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        const same = Buffer.from(existing[0].digest).equals(input.digest);
        if (!same) {
          throw ApiError.conflict('checkpoint version reuse with different digest', {
            checkpoint_ref: input.checkpointRef,
          });
        }
        return { accepted: true, replay: true };
      }
      await tx.insert(checkpoints).values({
        id: uuidv7(),
        organizationId: input.orgId,
        runId: input.runId,
        checkpointRef: input.checkpointRef,
        checkpointVersion: input.checkpointVersion,
        artifactId: input.artifactId ?? null,
        digest: input.digest,
        producer: input.producer,
      });
      return { accepted: true, replay: false };
    });
  }

  /** GetLatestCheckpoint (contract v1.3, FL-2.17) — newest run checkpoint. */
  async getLatestCheckpoint(input: {
    orgId: string;
    runId: string;
  }): Promise<CheckpointData | null> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(checkpoints)
        .where(
          and(eq(checkpoints.organizationId, input.orgId), eq(checkpoints.runId, input.runId)),
        )
        .orderBy(desc(checkpoints.checkpointVersion))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      let artifact:
        | {
            artifactId: string;
            mediaType: string;
            byteLength: number;
            sha256: Buffer;
            purpose: string;
          }
        | undefined;
      if (row.artifactId) {
        const artRows = await tx
          .select()
          .from(artifacts)
          .where(eq(artifacts.id, row.artifactId))
          .limit(1);
        const art = artRows[0];
        if (art) {
          artifact = {
            artifactId: art.id,
            mediaType: art.contentTypeDetected ?? art.contentTypeDeclared,
            byteLength: art.byteLength,
            sha256: Buffer.from(art.sha256),
            purpose: art.purpose,
          };
        }
      }
      return {
        checkpointRef: row.checkpointRef,
        checkpointVersion: row.checkpointVersion,
        artifact,
      };
    });
  }
}
