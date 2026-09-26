/**
 * MongoDB checkpoint repository (P3) — the persistence port for run
 * checkpoints (`McpAuthorityService` §5.8, mechanically moved in
 * `PgCheckpointRepository`).
 *
 * - one `MongoDbService.withOrg` transaction per unit;
 * - UUIDs as BSON Binary subtype 4, timestamps as canonical ISO-8601
 *   strings, BYTEA digests as Binary subtype 0;
 * - `(run_id, checkpoint_ref, checkpoint_version)` is the checkpoint key —
 *   a lost insert race replays same-digest writes and conflicts on digest
 *   mismatch (the pg lane's unique index cannot be relied on to surface a
 *   typed error, so the classifier is lookup-first + duplicate-key).
 */
import { Binary, MongoServerError } from 'mongodb';
import type { ClientSession, Document, WithId } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { nowIso, uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { CheckpointData, ICheckpointRepository } from './checkpoint.repository';

/** `checkpoints` document — pg `checkpoints` row shape (plan D4). */
interface CheckpointDoc extends Document {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  checkpoint_ref: string;
  checkpoint_version: number;
  artifact_id: Binary | null;
  digest: Binary;
  producer: string;
  created_at: string;
}

/** `artifacts` document — only the fields the checkpoint join reads. */
interface ArtifactDoc extends Document {
  id: Binary;
  organization_id: Binary;
  purpose: string;
  content_type_declared: string;
  content_type_detected: string | null;
  byte_length: number;
  sha256: Binary;
}

export class MongoCheckpointRepository implements ICheckpointRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private sessionOpt(ctx: MongoTxContext): { session: ClientSession } {
    return { session: ctx.session };
  }

  private tenantOrgId(ctx: MongoTxContext): string {
    const orgId = ctx.orgId;
    if (!orgId) {
      throw new Error(
        'MongoCheckpointRepository: tenant context required (unreachable under withOrg)',
      );
    }
    return orgId;
  }

  async saveCheckpointRef(input: {
    orgId: string;
    runId: string;
    checkpointRef: string;
    checkpointVersion: number;
    artifactId?: string;
    digest: Buffer;
    producer: string;
  }): Promise<{ accepted: boolean; replay: boolean }> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const checkpoints = new TenantScopedCollection<CheckpointDoc>(
        db.collection('checkpoints'),
      );
      const key = {
        run_id: uuidToBinary(input.runId),
        checkpoint_ref: input.checkpointRef,
        checkpoint_version: input.checkpointVersion,
      };

      const existing = await checkpoints.findOne(orgId, key, s);
      if (existing) {
        const same = Buffer.from(existing.digest.buffer).equals(input.digest);
        if (!same) {
          throw ApiError.conflict('checkpoint version reuse with different digest', {
            checkpoint_ref: input.checkpointRef,
          });
        }
        return { accepted: true, replay: true };
      }
      // organization_id is injected by TenantScopedCollection.insertOne —
      // the cast reflects the runtime injection.
      const doc = {
        id: uuidToBinary(uuidv7()),
        run_id: uuidToBinary(input.runId),
        checkpoint_ref: input.checkpointRef,
        checkpoint_version: input.checkpointVersion,
        artifact_id: input.artifactId ? uuidToBinary(input.artifactId) : null,
        digest: new Binary(input.digest),
        producer: input.producer,
        created_at: nowIso(),
      } as CheckpointDoc;
      try {
        await checkpoints.insertOne(orgId, doc, s);
      } catch (err) {
        // Defensive backstop for the pg lane's uq_checkpoints_run_version: a
        // lost race replays same-digest writes and conflicts on mismatch.
        if (!(err instanceof MongoServerError) || err.code !== 11000) throw err;
        const raced = await checkpoints.findOne(orgId, key, s);
        if (raced && Buffer.from(raced.digest.buffer).equals(input.digest)) {
          return { accepted: true, replay: true };
        }
        throw ApiError.conflict('checkpoint version reuse with different digest', {
          checkpoint_ref: input.checkpointRef,
        });
      }
      return { accepted: true, replay: false };
    });
  }

  async getLatestCheckpoint(input: {
    orgId: string;
    runId: string;
  }): Promise<CheckpointData | null> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const db = this.mongo.root;
      const s = this.sessionOpt(ctx);
      const orgId = this.tenantOrgId(ctx);
      const checkpoints = new TenantScopedCollection<CheckpointDoc>(
        db.collection('checkpoints'),
      );
      const row = await checkpoints.findOne(
        orgId,
        { run_id: uuidToBinary(input.runId) },
        { ...s, sort: { checkpoint_version: -1 } },
      );
      if (!row) {
        return null;
      }
      let artifact: CheckpointData['artifact'] | undefined;
      if (row.artifact_id) {
        const artifacts = new TenantScopedCollection<ArtifactDoc>(
          db.collection('artifacts'),
        );
        const art: WithId<ArtifactDoc> | null = await artifacts.findOne(
          orgId,
          { id: row.artifact_id },
          s,
        );
        if (art) {
          artifact = {
            artifactId: art.id.toUUID().toString(),
            mediaType: art.content_type_detected ?? art.content_type_declared,
            byteLength: art.byte_length,
            sha256: Buffer.from(art.sha256.buffer),
            purpose: art.purpose,
          };
        }
      }
      return {
        checkpointRef: row.checkpoint_ref,
        checkpointVersion: row.checkpoint_version,
        artifact,
      };
    });
  }
}
