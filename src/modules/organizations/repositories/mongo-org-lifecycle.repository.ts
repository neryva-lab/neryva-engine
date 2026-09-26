import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  ensureLifecycleIndexes,
  nowIso,
  orgCollection,
  toMembershipRow,
  toOrgDeletionRow,
  uuidOf,
} from './mongo-documents';
import type { MembershipMongoDoc, OrgDeletionMongoDoc } from './mongo-documents';
import type { DeletionRow, IOrgLifecycleRepository, MembershipRow } from './org-lifecycle.repository';

/**
 * MongoDB lane for `IOrgLifecycleRepository` (P3).
 *
 * Plan D4: UUIDs are BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Multi-write
 * units (`transferOwnership`, the purge delete pass) run inside one
 * `withOrg` transaction, mirroring the pg lane's transaction boundaries.
 *
 * Tenant discipline: `org_deletions` / `org_memberships` / `org_invites` /
 * `org_service_accounts` and the purge targets are `TenantScopedCollection`
 * (tenant key `org_id`, Binary predicate — the canonical D4
 * representation). `listDeletionsDue` is the deliberate cross-org
 * administrative read → `PlatformCollection` with the justifying comment,
 * mirroring the pg lane's `withBypass`. `revokeApiKeysForOrg` targets the
 * Python-owned `api_keys` collection (no tenant guard on either lane) with
 * an explicit `organization_id` predicate.
 *
 * The ownership-transfer 11000 (partial unique index
 * `uq_one_active_owner_per_org`) propagates raw — the pg lane's 23505
 * propagates raw too (the service never translated it).
 */
export class MongoOrgLifecycleRepository implements IOrgLifecycleRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    deletions: TenantScopedCollection<OrgDeletionMongoDoc>;
    memberships: TenantScopedCollection<MembershipMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      deletions: orgCollection<OrgDeletionMongoDoc>(db, 'org_deletions'),
      memberships: orgCollection<MembershipMongoDoc>(db, 'org_memberships'),
    };
  }

  async transferOwnership(input: {
    orgId: string;
    currentOwnerAccountId: string;
    newOwnerAccountId: string;
  }): Promise<void> {
    const db = this.mongo.root;
    await ensureLifecycleIndexes(db);
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      // Demote first, then promote — the only ordering that never
      // momentarily holds two active owners, so the partial unique index
      // holds at every statement boundary (pg twin: demote-then-promote).
      const demoted = await t.memberships.updateOne(
        input.orgId,
        {
          account_id: binUuid(input.currentOwnerAccountId, 'currentOwnerAccountId'),
          role: 'owner',
          status: 'active',
        },
        { $set: { role: 'admin', updated_at: now } },
        t.session,
      );
      if (demoted.modifiedCount === 0) {
        throw ApiError.forbidden('only the current owner may transfer ownership');
      }
      const promoted = await t.memberships.updateOne(
        input.orgId,
        {
          account_id: binUuid(input.newOwnerAccountId, 'newOwnerAccountId'),
          status: 'active',
        },
        { $set: { role: 'owner', updated_at: now } },
        t.session,
      );
      if (promoted.modifiedCount === 0) {
        throw ApiError.notFound('target member (must be an active member of the org)');
      }
      const owners = await t.memberships.countDocuments(
        input.orgId,
        { role: 'owner', status: 'active' },
        t.session,
      );
      if (owners !== 1) {
        throw ApiError.conflict('ownership transfer must leave exactly one active owner');
      }
    });
  }

  async getDeletion(orgId: string): Promise<DeletionRow | null> {
    const db = this.mongo.root;
    await ensureLifecycleIndexes(db);
    const doc = await orgCollection<OrgDeletionMongoDoc>(db, 'org_deletions').findOne(orgId, {});
    return doc ? toOrgDeletionRow(doc) : null;
  }

  async requestDeletion(input: { orgId: string; requestedBy: string; scheduledPurgeAt: string }): Promise<void> {
    const db = this.mongo.root;
    await ensureLifecycleIndexes(db);
    const now = nowIso();
    // Upsert on the unique org_id index; created_at is $setOnInsert so a
    // re-request preserves the original creation timestamp — same as the pg
    // lane's onConflictDoUpdate (which never rewrites created_at).
    await orgCollection<OrgDeletionMongoDoc>(db, 'org_deletions').updateOne(
      input.orgId,
      {},
      {
        $set: {
          requested_by: binUuid(input.requestedBy, 'requestedBy'),
          status: 'requested',
          scheduled_purge_at: input.scheduledPurgeAt,
          cancelled_at: null,
          purged_at: null,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
  }

  async cancelDeletion(orgId: string): Promise<void> {
    const db = this.mongo.root;
    await ensureLifecycleIndexes(db);
    const now = nowIso();
    await orgCollection<OrgDeletionMongoDoc>(db, 'org_deletions').updateOne(
      orgId,
      {},
      { $set: { status: 'cancelled', cancelled_at: now, updated_at: now } },
    );
  }

  async listDeletionsDue(nowIsoStr: string): Promise<string[]> {
    const db = this.mongo.root;
    await ensureLifecycleIndexes(db);
    // Justification (unscoped): the purge scheduler scans across orgs — an
    // explicitly administrative, cross-tenant read; mirrors the pg lane's
    // withBypass.
    const coll = new PlatformCollection<OrgDeletionMongoDoc>(db.collection<OrgDeletionMongoDoc>('org_deletions'));
    const docs = await coll
      .find({ status: 'requested', scheduled_purge_at: { $lte: nowIsoStr } })
      .toArray();
    return docs.map((doc) => uuidOf(doc.org_id));
  }

  async revokeInvitesForOrg(orgId: string): Promise<number> {
    const db = this.mongo.root;
    const result = await orgCollection(db, 'org_invites').updateMany(
      orgId,
      { revoked_at: null },
      { $set: { revoked_at: nowIso() } },
    );
    return result.modifiedCount;
  }

  async voidServiceAccountTokensForOrg(orgId: string): Promise<number> {
    const db = this.mongo.root;
    // Idempotent: only rows that still hold a token are touched, so a
    // second call returns 0 (the pg lane's `WHERE token_hash IS NOT NULL`
    // twin). Without the predicate, the always-changing updated_at would
    // make modifiedCount nonzero on every call.
    const result = await orgCollection(db, 'org_service_accounts').updateMany(
      orgId,
      { token_hash: { $ne: null } },
      { $set: { token_hash: null, token_prefix: null, token_expires_at: null, updated_at: nowIso() } },
    );
    return result.modifiedCount;
  }

  async revokeApiKeysForOrg(orgId: string): Promise<number> {
    const db = this.mongo.root;
    // api_keys is Python-owned without tenant guard on either lane — the
    // predicate stays explicit (organization_id, the mongo port's tenant
    // key for this collection).
    const coll = new PlatformCollection(db.collection('api_keys'));
    const result = await coll.updateMany(
      { organization_id: binUuid(orgId, 'orgId'), revoked: false },
      { $set: { revoked: true, updated_at: nowIso() } },
    );
    return result.modifiedCount;
  }

  async listMembershipRows(orgId: string): Promise<MembershipRow[]> {
    const db = this.mongo.root;
    const docs = await orgCollection<MembershipMongoDoc>(db, 'org_memberships').find(orgId, {}).toArray();
    return docs.map(toMembershipRow);
  }

  async purgeOrgData(orgId: string): Promise<Record<string, number>> {
    const db = this.mongo.root;
    await ensureLifecycleIndexes(db);
    const counts: Record<string, number> = {};
    // pg table → mongo collection (the product_deployment.* pg tables live
    // in product_deployment_<table> collections on this lane).
    const targets: Array<[string, string]> = [
      ['studio_project_keys', 'studio_project_keys'],
      ['product_deployment.deployment_events', 'product_deployment_deployment_events'],
      ['product_deployment.deployments', 'product_deployment_deployments'],
      ['product_deployment.pipeline_stages', 'product_deployment_pipeline_stages'],
      ['product_deployment.pipelines', 'product_deployment_pipelines'],
      ['product_deployment.secrets', 'product_deployment_secrets'],
      ['product_deployment.environments', 'product_deployment_environments'],
      ['published_configs', 'published_configs'],
      ['webhook_deliveries', 'webhook_deliveries'],
      ['webhooks', 'webhooks'],
      ['notifications', 'notifications'],
      ['org_group_members', 'org_group_members'],
      ['org_groups', 'org_groups'],
      ['org_service_accounts', 'org_service_accounts'],
      ['org_settings', 'org_settings'],
      ['projects', 'projects'],
      ['org_invites', 'org_invites'],
      ['org_memberships', 'org_memberships'],
      ['product_entitlements', 'product_entitlements'],
    ];
    // One transaction for the engine-owned delete pass, mirroring the pg
    // lane's single withOrg TX. Predicates use the canonical Binary
    // representation (plan D4).
    await this.mongo.withOrg(orgId, async (ctx) => {
      for (const [table, collection] of targets) {
        const result = await orgCollection(db, collection).deleteMany(orgId, {}, { session: ctx.session });
        counts[table] = result.deletedCount;
      }
    });

    // The tenants row is Python-owned: mark deleted via features.deleted
    // (the mongo twin of the pg lane's jsonb_set — documented dual-write
    // seam; DDL stays Python's).
    const now = nowIso();
    const tenants = new PlatformCollection(db.collection('tenants'));
    const marked = await tenants.updateOne(
      { id: binUuid(orgId, 'orgId') },
      { $set: { 'features.deleted': true, updated_at: now } },
    );
    counts['tenants.marked_deleted'] = marked.modifiedCount;

    await orgCollection<OrgDeletionMongoDoc>(db, 'org_deletions').updateOne(
      orgId,
      {},
      { $set: { status: 'purged', purged_at: now, updated_at: now } },
    );
    return counts;
  }
}
