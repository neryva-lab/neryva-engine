/**
 * MongoDB lane for `IRetentionPolicyRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/retention-purge.service.ts`.
 * The two sweeps evaluate eligibility in mongo queries instead of the pg
 * anti-join SQL, but keep the exact same semantics: only rows past their
 * keep window, and never a second task while one is
 * `pending`/`in_progress`/`blocked`/`done` for the same scope. ISO-8601
 * timestamp strings compare lexicographically, so the `created_at < cutoff`
 * window test is a plain `$lt`.
 */
import { Injectable } from '@nestjs/common';
import type { Db, Filter } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { PlatformCollection } from '../../../common/infra/db/mongo/concurrency';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { assertUuid } from '../assert';
import type { IRetentionPolicyRepository } from './retention-policy.repository';
import {
  requireOrg,
  tenantCollection,
  type LifecycleArtifactMongoDoc,
  type LifecycleConversationMongoDoc,
  type LifecycleTenantMongoDoc,
  type PurgeTaskMongoDoc,
  type RetentionPolicyMongoDoc,
} from './mongo-lifecycle-documents';

const ACTIVE_TASK_STATES = ['pending', 'in_progress', 'blocked', 'done'];

@Injectable()
export class MongoRetentionPolicyRepository implements IRetentionPolicyRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async upsertPolicy(input: {
    orgId: string;
    resourceType: string;
    retentionClass: string;
    keepDays: number;
    actor: string;
  }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const orgId = requireOrg(ctx);
      const policies = tenantCollection<RetentionPolicyMongoDoc>(db, 'retention_policies');
      const now = new Date().toISOString();
      // True upsert on (organization_id, resource_type, retention_class) —
      // a changed keep_days takes effect, never silently swallowed. Mirrors
      // the pg onConflictDoUpdate: only keep_until_rule is refreshed on the
      // conflict path; the original id/created_by survive.
      await policies.updateOne(
        orgId,
        {
          resource_type: input.resourceType,
          retention_class: input.retentionClass,
        },
        {
          $set: { keep_until_rule: { keep_days: input.keepDays } },
          $setOnInsert: {
            id: uuidToBinary(uuidv7()),
            organization_id: uuidToBinary(orgId),
            resource_type: input.resourceType,
            retention_class: input.retentionClass,
            created_by: input.actor,
            created_at: now,
          },
        },
        { session: ctx.session, upsert: true },
      );
    });
  }

  async sweepArtifactRetention(orgId: string): Promise<number> {
    assertUuid(orgId, 'orgId');
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      const policies = tenantCollection<RetentionPolicyMongoDoc>(db, 'retention_policies');
      const artifacts = tenantCollection<LifecycleArtifactMongoDoc>(db, 'artifacts');
      const tasks = tenantCollection<PurgeTaskMongoDoc>(db, 'purge_tasks');

      const policyDocs = await policies
        .find(tenantId, { resource_type: 'artifact' }, sessionOpt)
        .toArray();
      let created = 0;
      for (const policy of policyDocs) {
        const keepDays = (policy.keep_until_rule as { keep_days?: unknown } | null)?.keep_days;
        if (!Number.isInteger(keepDays) || (keepDays as number) < 1) {
          continue; // fail-safe: an invalid rule never flags data for deletion
        }
        const cutoff = new Date(Date.now() - (keepDays as number) * 24 * 3600 * 1000).toISOString();
        const eligible = await artifacts
          .find(
            tenantId,
            {
              state: 'active',
              retention_class: policy.retention_class,
              created_at: { $lt: cutoff },
            },
            sessionOpt,
          )
          .toArray();
        if (eligible.length === 0) {
          continue;
        }
        const existing = await this.existingScopeIds(db, ctx, tenantId, eligible.map((a) => a.id));
        const now = new Date().toISOString();
        for (const artifact of eligible) {
          const scopeId = artifact.id.toUUID().toString();
          if (existing.has(scopeId)) {
            continue;
          }
          await tasks.insertOne(
            tenantId,
            {
              id: uuidToBinary(uuidv7()),
              organization_id: uuidToBinary(tenantId),
              scope_type: 'artifact',
              scope_id: artifact.id,
              reason: 'retention_expiry',
              state: 'pending',
              step: 'authorize',
              last_error: null,
              evidence: null,
              locked_at: null,
              created_at: now,
              finished_at: null,
            },
            sessionOpt,
          );
          created += 1;
        }
      }
      return created;
    });
  }

  async sweepConversationRetention(orgId: string): Promise<number> {
    assertUuid(orgId, 'orgId');
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const sessionOpt = { session: ctx.session };
      // tenants is python-owned; the pg lane reads retention_days from the
      // same table (joined as text). Null retention_days = keep indefinitely.
      const tenantDoc = await db
        .collection<LifecycleTenantMongoDoc>('tenants')
        .findOne({ id: orgId } as Filter<LifecycleTenantMongoDoc>, sessionOpt);
      const retentionDays = tenantDoc?.retention_days ?? null;
      if (retentionDays === null || !Number.isInteger(retentionDays) || retentionDays < 1) {
        return 0;
      }
      const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
      const conversations = tenantCollection<LifecycleConversationMongoDoc>(db, 'conversations');
      const tasks = tenantCollection<PurgeTaskMongoDoc>(db, 'purge_tasks');
      const eligible = await conversations
        .find(
          tenantId,
          { status: { $ne: 'deleted' }, created_at: { $lt: cutoff } },
          sessionOpt,
        )
        .toArray();
      if (eligible.length === 0) {
        return 0;
      }
      const existing = await this.existingScopeIds(db, ctx, tenantId, eligible.map((c) => c.id));
      const now = new Date().toISOString();
      let created = 0;
      for (const conv of eligible) {
        const scopeId = conv.id.toUUID().toString();
        if (existing.has(scopeId)) {
          continue;
        }
        await tasks.insertOne(
          tenantId,
          {
            id: uuidToBinary(uuidv7()),
            organization_id: uuidToBinary(tenantId),
            scope_type: 'conversation',
            scope_id: conv.id,
            reason: 'retention_expiry',
            state: 'pending',
            step: 'authorize',
            last_error: null,
            evidence: null,
            locked_at: null,
            created_at: now,
            finished_at: null,
          },
          sessionOpt,
        );
        created += 1;
      }
      return created;
    });
  }

  async listTenantIds(): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const tenants = new PlatformCollection<LifecycleTenantMongoDoc>(db.collection<LifecycleTenantMongoDoc>('tenants'));
      const docs = await tenants.find({}, { session: ctx.session }).toArray();
      return docs.map((d) => (typeof d.id === 'string' ? d.id : d.id.toUUID().toString()));
    });
  }

  /**
   * The `not exists (... state in (...))` anti-join from the pg sweeps:
   * scope ids that already have a live-or-finished task.
   */
  private async existingScopeIds(
    db: Db,
    ctx: MongoTxContext,
    orgId: string,
    scopeIds: import('mongodb').Binary[],
  ): Promise<Set<string>> {
    if (scopeIds.length === 0) {
      return new Set();
    }
    const tasks = tenantCollection<PurgeTaskMongoDoc>(db, 'purge_tasks');
    const docs = await tasks
      .find(
        orgId,
        { scope_id: { $in: scopeIds }, state: { $in: ACTIVE_TASK_STATES } },
        { session: ctx.session, projection: { scope_id: 1 } },
      )
      .toArray();
    return new Set(docs.map((d) => d.scope_id.toUUID().toString()));
  }
}
