import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  ensureInfoIndexes,
  isDuplicateKey,
  nowIso,
  orgCollection,
} from './mongo-documents';
import type {
  InfoTenantMongoDoc,
  MembershipMongoDoc,
  OrgSettingsDoc,
} from './mongo-documents';
import type { IOrgAccessRepository } from './org-access.repository';

/**
 * MongoDB lane for `IOrgAccessRepository` (P3).
 *
 * Plan D4: UUIDs are BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. The creation
 * transaction runs in one `withOrg` session: the `tenants` insert is the
 * deliberate unscoped write (mirrors the pg lane's `db.root` INSERT —
 * `tenants` is Python-owned DDL), membership/settings go through
 * `TenantScopedCollection`.
 *
 * A slug collision (11000 on `uq_tenants_slug`, ensured defensively here)
 * throws the same `ApiError.conflict('that workspace address is already
 * taken', { reason: 'slug_taken' })` the pg lane returns — the service
 * drops its old `pgViolation` mapping for this call (behavior-preserving:
 * same 409).
 */
export class MongoOrgAccessRepository implements IOrgAccessRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    tenants: PlatformCollection<InfoTenantMongoDoc>;
    memberships: TenantScopedCollection<MembershipMongoDoc>;
    settings: TenantScopedCollection<OrgSettingsDoc>;
  } {
    return {
      session: { session: ctx.session },
      // Justification (unscoped): the Python-owned `tenants` seam — engine
      // INSERTs new orgs by explicit id; mirrors the pg lane's db.root
      // write. Every access is by the new org's id, never a scan.
      tenants: new PlatformCollection<InfoTenantMongoDoc>(db.collection<InfoTenantMongoDoc>('tenants')),
      memberships: orgCollection<MembershipMongoDoc>(db, 'org_memberships'),
      settings: orgCollection<OrgSettingsDoc>(db, 'org_settings'),
    };
  }

  async createOrgWithOwner(input: {
    orgId: string;
    slug: string;
    name: string;
    accountId: string;
    kind: 'personal' | 'team';
  }): Promise<void> {
    const db = this.mongo.root;
    await ensureInfoIndexes(db);
    const now = nowIso();
    // Defaults mirror the pg lane's explicit INSERT (which itself mirrors
    // Python's TenantModel defaults).
    const tenantDoc: InfoTenantMongoDoc = {
      id: binUuid(input.orgId, 'orgId'),
      slug: input.slug,
      name: input.name,
      allowed_topics: [],
      blocked_topics: [],
      escalation_threshold: 0.7,
      knowledge_allowlist: [],
      default_provider: 'openai',
      default_model: 'gpt-4',
      features: {},
      guardrail_config: {},
      guardrail_thresholds: {},
      region: null,
      retention_days: null,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    const membershipDoc: MembershipMongoDoc = {
      id: binUuid(uuidv7()),
      account_id: binUuid(input.accountId, 'accountId'),
      org_id: binUuid(input.orgId, 'orgId'),
      role: 'owner',
      status: 'active',
      invited_by: null,
      last_active_at: null,
      suspended_at: null,
      suspended_by: null,
      created_at: now,
      updated_at: now,
    };
    const settingsDoc: OrgSettingsDoc = {
      org_id: binUuid(input.orgId, 'orgId'),
      kind: input.kind,
      support_email: null,
      default_project_id: null,
      branding: {},
      preferences: {},
      created_at: now,
      updated_at: now,
    };
    try {
      await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        await t.tenants.insertOne(tenantDoc, t.session);
        await t.memberships.insertOne(input.orgId, membershipDoc, t.session);
        if (input.kind === 'team') {
          // The pg lane's onConflictDoNothing: a repeated creation attempt
          // for the same org keeps the first settings row. An upsert with
          // $setOnInsert is the exact twin — a swallowed 11000 inside the
          // transaction would abort the whole TX, so this never throws it.
          await t.settings.updateOne(
            input.orgId,
            {},
            { $setOnInsert: settingsDoc },
            { ...t.session, upsert: true },
          );
        }
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw ApiError.conflict('that workspace address is already taken', { reason: 'slug_taken' });
      }
      throw err;
    }
  }

  async countOwnedOrgs(accountId: string): Promise<number> {
    const db = this.mongo.root;
    // Justification (unscoped): the caller's own ownership rows span orgs
    // by definition; the query filters account_id explicitly — mirrors the
    // pg lane's withBypass.
    const coll = new PlatformCollection<MembershipMongoDoc>(db.collection<MembershipMongoDoc>('org_memberships'));
    return coll.countDocuments({
      account_id: binUuid(accountId, 'accountId'),
      role: 'owner',
      status: 'active',
    });
  }
}
