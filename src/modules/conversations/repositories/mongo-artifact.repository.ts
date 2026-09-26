/**
 * MongoDB artifact repository (P3) — the persistence port for run artifacts
 * (`McpAuthorityService` artifact registration + the GetRunArtifact
 * claim-check facade reads, mechanically moved in `PgArtifactRepository`).
 *
 * - one `MongoDbService.withOrg` transaction per unit;
 * - UUIDs as BSON Binary subtype 4, timestamps as canonical ISO-8601
 *   strings, BYTEA checksums as Binary subtype 0;
 * - `findRunArtifact` returns the artifact row (org-scoped) and whether it
 *   is bound to the run via its checkpoints, tool effects, or run events.
 *   The 7 facade checks and the presigned URL stay in the service.
 */
import { Binary } from 'mongodb';
import type { ClientSession, Document, WithId } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { IArtifactRepository, RunArtifactData } from './artifact.repository';

/** `artifacts` document — pg `artifacts` (knowledge) row shape (plan D4). */
interface ArtifactDoc extends Document {
  id: Binary;
  organization_id: Binary;
  purpose: string;
  object_key: string;
  content_type_declared: string;
  content_type_detected: string | null;
  byte_length: number;
  sha256: Binary | null;
  encryption_key_ref: string | null;
  scan_status: string;
  state: string;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** `checkpoints` document — only the `bound` probe reads this. */
interface CheckpointDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  artifact_id: Binary | null;
}

/** `tool_effects` document — only the `bound` probe reads this. */
interface ToolEffectDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  result_artifact_id: Binary | null;
}

/** `run_events` document — only the `bound` probe reads this. */
interface RunEventDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  artifact_id: Binary | null;
}

export class MongoArtifactRepository implements IArtifactRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private sessionOpt(ctx: MongoTxContext): { session: ClientSession } {
    return { session: ctx.session };
  }

  private tenantOrgId(ctx: MongoTxContext): string {
    const orgId = ctx.orgId;
    if (!orgId) {
      throw new Error(
        'MongoArtifactRepository: tenant context required (unreachable under withOrg)',
      );
    }
    return orgId;
  }

  /**
   * Register the artifact row for just-uploaded bytes (bytes already in
   * storage). Mirrors `putRunArtifact`'s row insert: ACTIVE state, skipped
   * scan, detected content type starts as the declared one, runtime creator.
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
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const orgId = this.tenantOrgId(ctx);
      const artifacts = new TenantScopedCollection<ArtifactDoc>(
        this.mongo.root.collection('artifacts'),
      );
      // organization_id is injected by TenantScopedCollection.insertOne —
      // the cast reflects the runtime injection.
      const doc = {
        id: uuidToBinary(input.artifactId),
        purpose: input.purpose,
        object_key: input.objectKey,
        content_type_declared: input.mediaType,
        content_type_detected: input.mediaType,
        byte_length: input.byteLength,
        sha256: new Binary(input.sha256),
        encryption_key_ref: null,
        scan_status: 'skipped',
        state: 'active',
        expires_at: null,
        created_by: 'agent-studio-runtime',
        created_at: nowIso(),
      } as ArtifactDoc;
      await artifacts.insertOne(orgId, doc, this.sessionOpt(ctx));
    });
  }

  /**
   * Artifact facade read: the artifact row (org-scoped) and whether it is
   * bound to this run via its checkpoints, tool effects, or run events.
   */
  async findRunArtifact(input: {
    orgId: string;
    runId: string;
    artifactId: string;
  }): Promise<RunArtifactData> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const artifactBin = uuidToBinary(input.artifactId);
      const runBin = uuidToBinary(input.runId);

      const artifacts = new TenantScopedCollection<ArtifactDoc>(
        db.collection('artifacts'),
      );
      const art: WithId<ArtifactDoc> | null = await artifacts.findOne(
        orgId,
        { id: artifactBin },
        s,
      );
      // A run's capability never reads another conversation's artifact: the
      // binding must go through this run's checkpoints, tool effects, or
      // run events (pg: three-way UNION ALL ... LIMIT 1).
      const [checkpointHit, effectHit, eventHit] = await Promise.all([
        new TenantScopedCollection<CheckpointDoc>(db.collection('checkpoints')).findOne(
          orgId,
          { run_id: runBin, artifact_id: artifactBin },
          { ...s, projection: { _id: 1 } },
        ),
        new TenantScopedCollection<ToolEffectDoc>(db.collection('tool_effects')).findOne(
          orgId,
          { run_id: runBin, result_artifact_id: artifactBin },
          { ...s, projection: { _id: 1 } },
        ),
        new TenantScopedCollection<RunEventDoc>(db.collection('run_events')).findOne(
          orgId,
          { run_id: runBin, artifact_id: artifactBin },
          { ...s, projection: { _id: 1 } },
        ),
      ]);
      return {
        artifact: art
          ? {
              id: art.id.toUUID().toString(),
              purpose: art.purpose,
              expiresAt: art.expires_at,
              sha256: art.sha256 ? Buffer.from(art.sha256.buffer) : null,
              byteLength: art.byte_length,
              state: art.state,
              scanStatus: art.scan_status,
              objectKey: art.object_key,
              contentTypeDetected: art.content_type_detected,
              contentTypeDeclared: art.content_type_declared,
              encryptionKeyRef: art.encryption_key_ref,
            }
          : null,
        bound: Boolean(checkpointHit || effectHit || eventHit),
      };
    });
  }
}
