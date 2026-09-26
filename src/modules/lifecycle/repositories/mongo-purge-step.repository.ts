/**
 * MongoDB lane for `IPurgeStepRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/retention-purge.service.ts`
 * (`stepCheckHolds` / `stepMarkUnavailable` / `stepEmitDerivedDeletion` /
 * `stepPurgeObjects`' queries / `stepPurgeContent` / `stepTombstone`'s
 * insert). Byte-identical behavior, same tenant scoping — the queries moved
 * here mechanically; no logic changed.
 *
 * Object storage deletion itself stays in the service (`StorageService`):
 * this port lists the purgeable object keys and flips the artifact rows.
 * Conversation-scoped artifact lookup uses `$lookup` unions against
 * run_events/checkpoints/tool_effects, replacing the pg `IN (UNION ...)`
 * — same set, same scope.
 */
import { Injectable } from '@nestjs/common';
import type { Binary, Db, Filter } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { recordMongoOutboxEvent } from '../../../common/infra/outbox/mongo-outbox.service';
import { PlatformCollection } from '../../../common/infra/db/mongo/concurrency';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { assertUuid } from '../assert';
import type { IPurgeStepRepository } from './purge-step.repository';
import {
  requireOrg,
  tenantCollection,
  type LifecycleArtifactMongoDoc,
  type LifecycleCheckpointArtifactMongoDoc,
  type LifecycleConversationMongoDoc,
  type LifecycleMemoryItemMongoDoc,
  type LifecycleMessageRefMongoDoc,
  type LifecycleRunConversationMongoDoc,
  type LifecycleRunEventArtifactMongoDoc,
  type LifecycleToolEffectArtifactMongoDoc,
  type LegalHoldMongoDoc,
  type TombstoneMongoDoc,
} from './mongo-lifecycle-documents';

@Injectable()
export class MongoPurgeStepRepository implements IPurgeStepRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async findBlockingHold(orgId: string, scopeType: string, scopeId: string): Promise<boolean> {
    assertUuid(orgId, 'orgId');
    assertUuid(scopeId, 'scopeId');
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const holds = tenantCollection<LegalHoldMongoDoc>(db, 'legal_holds');
      const now = new Date().toISOString();
      // Mirrors the pg predicate exactly: an ACTIVE, unexpired hold that is
      // org-wide OR scoped to exactly this (scopeType, scopeId).
      const filter: Filter<LegalHoldMongoDoc> = {
        $and: [
          { status: 'active' },
          { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
          {
            $or: [
              { scope_type: 'organization' },
              { scope_type: scopeType, scope_id: uuidToBinary(scopeId) },
            ],
          },
        ],
      };
      const doc = await holds.findOne(tenantId, filter, { session: ctx.session });
      return doc !== null;
    });
  }

  async markUnavailable(input: {
    orgId: string;
    scopeType: 'conversation' | 'artifact';
    scopeId: string;
  }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const now = new Date().toISOString();
      if (input.scopeType === 'conversation') {
        const conversations = tenantCollection<LifecycleConversationMongoDoc>(db, 'conversations');
        await conversations.updateOne(
          tenantId,
          { id: uuidToBinary(input.scopeId) },
          { $set: { status: 'deleted', updated_at: now } },
          sessionOpt,
        );
      } else {
        const artifacts = tenantCollection<LifecycleArtifactMongoDoc>(db, 'artifacts');
        await artifacts.updateOne(
          tenantId,
          { id: uuidToBinary(input.scopeId) },
          { $set: { state: 'retiring', updated_at: now } },
          sessionOpt,
        );
      }
    });
  }

  async emitDerivedDeletion(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      await recordMongoOutboxEvent(ctx, this.mongo, {
        aggregateType: input.scopeType,
        aggregateId: input.scopeId,
        organizationId: input.orgId,
        eventType: input.scopeType === 'conversation' ? 'conversation.purged' : 'artifact.purged',
        partitionKey: input.scopeId,
        payload: { scope_type: input.scopeType, scope_id: input.scopeId, reason: input.reason },
      });
    });
  }

  async listPurgeableObjects(input: {
    orgId: string;
    scopeType: 'conversation' | 'artifact';
    scopeId: string;
    limit: number;
  }): Promise<Array<{ id: string; objectKey: string }>> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const artifacts = tenantCollection<LifecycleArtifactMongoDoc>(db, 'artifacts');
      const scopeBin = uuidToBinary(input.scopeId);
      if (input.scopeType === 'artifact') {
        const docs = await artifacts
          .find(
            tenantId,
            { id: scopeBin, state: { $in: ['active', 'retiring'] } },
            { ...sessionOpt, limit: input.limit },
          )
          .toArray();
        return docs.map((d) => ({ id: d.id.toUUID().toString(), objectKey: d.object_key }));
      }
      // Conversation scope: ONLY artifacts bound to THIS conversation via
      // its runs (run_events / checkpoints / tool outcomes). The mongo
      // equivalent of the pg UNION subquery.
      const runIdCol = await this.runIdsForConversation(db, ctx, tenantId, scopeBin);
      if (runIdCol.length === 0) {
        return [];
      }
      const artifactIds = await this.artifactIdsForRuns(db, ctx, tenantId, runIdCol);
      if (artifactIds.length === 0) {
        return [];
      }
      const docs = await artifacts
        .find(
          tenantId,
          { id: { $in: artifactIds }, state: { $in: ['active', 'retiring'] } },
          { ...sessionOpt, limit: input.limit },
        )
        .toArray();
      return docs.map((d) => ({ id: d.id.toUUID().toString(), objectKey: d.object_key }));
    });
  }

  async markObjectPurged(objectId: string): Promise<void> {
    assertUuid(objectId, 'objectId');
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const artifacts = new PlatformCollection<LifecycleArtifactMongoDoc>(
        db.collection<LifecycleArtifactMongoDoc>('artifacts'),
      );
      await artifacts.updateOne(
        { id: uuidToBinary(objectId) },
        { $set: { state: 'purged', updated_at: new Date().toISOString() } },
        { session: ctx.session },
      );
    });
  }

  async purgeConversationContent(orgId: string, conversationId: string): Promise<void> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const convBin = uuidToBinary(conversationId);
      const messages = tenantCollection<LifecycleMessageRefMongoDoc>(db, 'messages');
      await messages.deleteMany(tenantId, { conversation_id: convBin }, sessionOpt);
      // Runs are kept as redacted skeletons for billing/audit
      // explainability — same as pg (no run deletion).
      const memoryItems = tenantCollection<LifecycleMemoryItemMongoDoc>(db, 'memory_items');
      const now = new Date().toISOString();
      await memoryItems.updateMany(
        tenantId,
        { scope_type: 'conversation', scope_id: convBin },
        { $set: { deleted_at: now, updated_at: now } },
        sessionOpt,
      );
    });
  }

  async writeTombstone(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const tombstones = new PlatformCollection<TombstoneMongoDoc>(db.collection<TombstoneMongoDoc>('tombstones'));
      // Idempotent: the pg onConflictDoNothing() equivalent. The unique
      // (resource_type, resource_id) index makes the second insert a no-op
      // via updateOne-with-$setOnInsert.
      await tombstones.updateOne(
        { resource_type: input.scopeType, resource_id: uuidToBinary(input.scopeId) },
        {
          $setOnInsert: {
            id: uuidToBinary(uuidv7()),
            organization_id: uuidToBinary(input.orgId),
            resource_type: input.scopeType,
            resource_id: uuidToBinary(input.scopeId),
            reason: input.reason,
            purged_at: new Date().toISOString(),
          },
        },
        { session: ctx.session, upsert: true },
      );
    });
  }

  async findTombstone(resourceType: string, resourceId: string): Promise<{ reason: string } | null> {
    assertUuid(resourceId, 'resourceId');
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const tombstones = new PlatformCollection<TombstoneMongoDoc>(db.collection<TombstoneMongoDoc>('tombstones'));
      const doc = await tombstones.findOne(
        { resource_type: resourceType, resource_id: uuidToBinary(resourceId) },
        { session: ctx.session, projection: { reason: 1 } },
      );
      return doc ? { reason: doc.reason } : null;
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async runIdsForConversation(
    db: Db,
    ctx: MongoTxContext,
    tenantId: string,
    conversationBin: Binary,
  ): Promise<Binary[]> {
    const runs = tenantCollection<LifecycleRunConversationMongoDoc>(db, 'runs');
    const docs = await runs
      .find(tenantId, { conversation_id: conversationBin }, { session: ctx.session, projection: { id: 1 } })
      .toArray();
    return docs.map((d) => d.id);
  }

  private async artifactIdsForRuns(
    db: Db,
    ctx: MongoTxContext,
    tenantId: string,
    runIds: Binary[],
  ): Promise<Binary[]> {
    const sessionOpt = { session: ctx.session };
    const seen = new Set<string>();
    const runEvents = tenantCollection<LifecycleRunEventArtifactMongoDoc>(db, 'run_events');
    const checkpoints = tenantCollection<LifecycleCheckpointArtifactMongoDoc>(db, 'checkpoints');
    const toolEffects = tenantCollection<LifecycleToolEffectArtifactMongoDoc>(db, 'tool_effects');
    const inRuns = { run_id: { $in: runIds } };
    const [events, cps, effects] = await Promise.all([
      runEvents.find(tenantId, inRuns, { ...sessionOpt, projection: { artifact_id: 1 } }).toArray(),
      checkpoints.find(tenantId, inRuns, { ...sessionOpt, projection: { artifact_id: 1 } }).toArray(),
      toolEffects.find(tenantId, inRuns, { ...sessionOpt, projection: { result_artifact_id: 1 } }).toArray(),
    ]);
    for (const doc of events) {
      if (doc.artifact_id) {
        seen.add(doc.artifact_id.toUUID().toString());
      }
    }
    for (const doc of cps) {
      if (doc.artifact_id) {
        seen.add(doc.artifact_id.toUUID().toString());
      }
    }
    for (const doc of effects) {
      if (doc.result_artifact_id) {
        seen.add(doc.result_artifact_id.toUUID().toString());
      }
    }
    return [...seen].map((s) => uuidToBinary(s));
  }
}
