/**
 * MongoDB `IPolicySnapshotRepository` — the `policy_snapshots` aggregate
 * on the mongo lane.
 *
 * Tenant discipline: every tenant-scoped access goes through
 * `TenantScopedCollection` (explicit `organization_id` predicates — there
 * is no RLS on this lane). UUIDs are BSON Binary subtype 4; the
 * `(assistant_version_id, hash)` content-addressed uniqueness is enforced
 * by the `uq_policy_snapshots_version_hash` index declared in the mongo
 * migrator, and duplicate-key errors (11000) on the idempotent insert
 * path resolve to a no-op — the lane twin of the pg
 * `onConflictDoNothing`.
 */
import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { AssistantPayload } from '../validation';
import { validateAssistantPayload } from '../validation';
import type { PolicySnapshot } from '../schema';
import type { IPolicySnapshotRepository } from './policy-snapshot.repository';
import { resolveForPublishMongo } from './mongo-manifest-resolution';
import {
  binToUuid,
  binUuid,
  isDuplicateKeyError,
  nowIsoString,
  toPolicySnapshot,
  uuidToBinary,
  type AssistantVersionMongoDoc,
  type PolicySnapshotMongoDoc,
} from './mongo-assistant-documents';

/** Must stay in sync with `POLICY_SNAPSHOT_SCHEMA_VERSION` in `../schema`. */
const POLICY_SNAPSHOT_SCHEMA_VERSION = 1;

@Injectable()
export class MongoPolicySnapshotRepository implements IPolicySnapshotRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db) {
    return {
      versions: new TenantScopedCollection<AssistantVersionMongoDoc>(
        db.collection<AssistantVersionMongoDoc>('assistant_versions'),
      ),
      snapshots: new TenantScopedCollection<PolicySnapshotMongoDoc>(
        db.collection<PolicySnapshotMongoDoc>('policy_snapshots'),
      ),
    };
  }

  async getSnapshot(orgId: string, snapshotId: string): Promise<PolicySnapshot | null> {
    const db = this.mongo.root;
    const { snapshots } = this.collections(db);
    const doc = await snapshots.findOne(orgId, { id: binUuid(snapshotId, 'snapshotId') });
    return doc ? toPolicySnapshot(doc) : null;
  }

  async getSnapshotForVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<PolicySnapshot | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const { versions, snapshots } = this.collections(db);
      const session = { session: ctx.session };
      const version = await versions.findOne(
        orgId,
        {
          id: binUuid(versionId, 'versionId'),
          assistant_id: binUuid(assistantId, 'assistantId'),
        },
        { ...session, projection: { hash: 1 } },
      );
      if (!version) {
        return null;
      }
      // Content-addressed: "the version's snapshot" is the row matching
      // the version's LIVE hash — older rows are immutable history for
      // runs dispatched against them.
      const doc = await snapshots.findOne(
        orgId,
        { assistant_version_id: binUuid(versionId, 'versionId'), hash: version.hash },
        session,
      );
      return doc ? toPolicySnapshot(doc) : null;
    });
  }

  async synthesizeSnapshotForVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const { versions, snapshots } = this.collections(db);
      const session = { session: ctx.session };
      const versionBin = binUuid(input.versionId, 'versionId');
      const version = await versions.findOne(input.orgId, { id: versionBin }, session);
      if (!version || binToUuid(version.assistant_id) !== input.assistantId) {
        throw ApiError.notFound('assistant version');
      }
      // Content-addressed + immutable: one row per (version, content hash).
      // A draft edited after the snapshot was taken INSERTS a new row —
      // never mutates the existing one.
      const existing = await snapshots.findOne(
        input.orgId,
        { assistant_version_id: versionBin, hash: version.hash },
        { ...session, projection: { id: 1 } },
      );
      if (existing) {
        return; // snapshot already reflects this exact content
      }
      const payload: AssistantPayload = {
        model_policy: version.model_policy as AssistantPayload['model_policy'],
        context_policy: version.context_policy as AssistantPayload['context_policy'],
        tool_policy: version.tool_policy as AssistantPayload['tool_policy'],
        knowledge_policy: (version.knowledge_policy ??
          undefined) as AssistantPayload['knowledge_policy'],
        guardrail_policy: version.guardrail_policy as AssistantPayload['guardrail_policy'],
        instructions: (version.instructions ?? undefined) as AssistantPayload['instructions'],
        model_params: (version.model_params ?? undefined) as AssistantPayload['model_params'],
        budget_policy: (version.budget_policy ?? undefined) as AssistantPayload['budget_policy'],
        brand: (version.brand ?? undefined) as AssistantPayload['brand'],
      };
      const validated = validateAssistantPayload(payload);
      if (!validated.ok) {
        throw ApiError.validation({ assistant: validated.issues });
      }
      const manifest = await resolveForPublishMongo(
        db,
        ctx.session,
        input.orgId,
        input.assistantId,
        validated.normalized,
      );
      const now = nowIsoString();
      const doc: PolicySnapshotMongoDoc = {
        id: uuidToBinary(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        assistant_version_id: versionBin,
        snapshot_version: POLICY_SNAPSHOT_SCHEMA_VERSION,
        model_policy: version.model_policy,
        context_policy: version.context_policy,
        tool_policy: version.tool_policy,
        guardrail_policy: version.guardrail_policy,
        knowledge_policy: version.knowledge_policy ?? null,
        instructions: version.instructions ?? null,
        model_params: version.model_params ?? null,
        budget_policy: version.budget_policy ?? null,
        brand: version.brand ?? null,
        hash: version.hash,
        tool_bindings: manifest.toolBindings,
        knowledge_pins: manifest.knowledgePins,
        model_ref: manifest.modelRef,
        template_ref: manifest.templateRef,
        manifest_hash: manifest.manifestHash,
        created_at: now,
      };
      try {
        await snapshots.insertOne(input.orgId, doc, session);
      } catch (err) {
        // Immutable rows: concurrent inserts of the same content resolve
        // via the unique (assistant_version_id, hash) index — the lane twin
        // of the pg `onConflictDoNothing`.
        if (isDuplicateKeyError(err)) return;
        throw err;
      }
    });
  }
}
