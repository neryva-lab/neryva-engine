/**
 * PostgreSQL artifact repository (P3) — run artifacts (ledger 5.12).
 *
 * Mechanical move of the durable halves of `McpAuthorityService`'s artifact
 * operations:
 *
 * - `registerArtifact` — the artifact-row insert from `putRunArtifact`
 *   (bytes are already in object storage; the put + tenant-key assertion +
 *   size/purpose validation stay in the service with `StorageService`).
 * - `findRunArtifact` — the artifact row read (org-scoped) and the
 *   run-scope binding check from `getRunArtifact`: the artifact must be
 *   referenced by this run's checkpoints, tool effects, or run events (a
 *   run's capability never reads another conversation's artifact). The 7
 *   facade checks and the presigned URL stay in the service.
 */
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { artifacts } from '../../knowledge/schema';
import type { IArtifactRepository, RunArtifactData } from './artifact.repository';

export class PgArtifactRepository implements IArtifactRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Register the artifact row for just-uploaded bytes (bytes already in
   * storage). The put is executed BEFORE the row insert in the service: a
   * crash leaves an orphan object (rebuildable, garbage-collectable), never
   * a row whose bytes are missing.
   */
  async registerArtifact(input: {
    orgId: string;
    artifactId: string;
    purpose: 'CHECKPOINT' | 'TOOL_RESULT' | 'GENERATED_MEDIA';
    objectKey: string;
    mediaType: string;
    byteLength: number;
    sha256: Buffer;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx.insert(artifacts).values({
        id: input.artifactId,
        organizationId: input.orgId,
        purpose: input.purpose,
        objectKey: input.objectKey,
        contentTypeDeclared: input.mediaType,
        contentTypeDetected: input.mediaType,
        byteLength: input.byteLength,
        sha256: input.sha256,
        scanStatus: 'skipped',
        state: 'active',
        createdBy: 'agent-studio-runtime',
      });
    });
  }

  /**
   * Artifact facade reads for GetRunArtifact (5.12 + Phase 7.9): the
   * artifact row (org-scoped) and whether it is bound to this run via its
   * checkpoints, tool effects, or run events. Existence/purpose/expiry/
   * checksum/bounds/deletion/scan-state checks (the 7 facade checks) and the
   * short-TTL presigned GET stay in the service.
   */
  async findRunArtifact(input: {
    orgId: string;
    runId: string;
    artifactId: string;
  }): Promise<RunArtifactData> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(artifacts)
        .where(
          and(eq(artifacts.id, input.artifactId), eq(artifacts.organizationId, input.orgId)),
        )
        .limit(1);
      const art = rows[0] ?? null;
      const binding = await (async () => {
        const cp = await tx.execute(sql`
          select 1 from checkpoints where run_id = ${input.runId}::uuid and artifact_id = ${input.artifactId}::uuid
          union all
          select 1 from tool_effects where run_id = ${input.runId}::uuid and result_artifact_id = ${input.artifactId}::uuid
          union all
          select 1 from run_events where run_id = ${input.runId}::uuid and artifact_id = ${input.artifactId}::uuid
          limit 1
        `);
        return cp.rows.length > 0;
      })();
      return {
        artifact: art
          ? {
              id: art.id,
              purpose: art.purpose,
              expiresAt: art.expiresAt,
              sha256: art.sha256 ? Buffer.from(art.sha256) : null,
              byteLength: art.byteLength,
              state: art.state,
              scanStatus: art.scanStatus,
              objectKey: art.objectKey,
              contentTypeDetected: art.contentTypeDetected,
              contentTypeDeclared: art.contentTypeDeclared,
              encryptionKeyRef: art.encryptionKeyRef,
            }
          : null,
        bound: binding,
      };
    });
  }
}
