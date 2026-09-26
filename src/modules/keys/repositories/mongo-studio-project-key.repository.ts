import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  IStudioProjectKeyRepository,
  ProjectKeyBindingRow,
} from './keys.repository';
import {
  binUuid,
  ensureKeysIndexes,
  isDuplicateKey,
  tenantCollection,
  toProjectKeyBindingRow,
} from './mongo-documents';
import type { StudioProjectKeyMongoDoc } from './mongo-documents';

/**
 * MongoDB lane for `IStudioProjectKeyRepository` (P3) — the
 * `studio_project_keys` binding furniture as driven by `KeysService` (K-2:
 * bind at issue time).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. The tenant
 * predicate is enforced by `TenantScopedCollection` on the `org_id` field
 * (the org-furniture group convention, plan D6).
 */
export class MongoStudioProjectKeyRepository implements IStudioProjectKeyRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    bindings: TenantScopedCollection<StudioProjectKeyMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      bindings: tenantCollection<StudioProjectKeyMongoDoc>(db, 'studio_project_keys', {
        tenantField: 'org_id',
      }),
    };
  }

  async bindKeyToProject(input: {
    orgId: string;
    apiKeyId: string;
    projectId: string;
    boundBy: string;
  }): Promise<void> {
    const db = this.mongo.root;
    await ensureKeysIndexes(db);
    // The bind is a single-document atomic insert — it deliberately does NOT
    // run inside a multi-document transaction: a duplicate-key (11000) on
    // the (org_id, api_key_id) unique index aborts its transaction, and any
    // follow-up work on that session then raises NoSuchTransaction. Catching
    // the duplicate outside any transaction and keeping the existing row
    // mirrors pg's onConflictDoNothing exactly.
    const bindings = tenantCollection<StudioProjectKeyMongoDoc>(db, 'studio_project_keys', {
      tenantField: 'org_id',
    });
    const doc: StudioProjectKeyMongoDoc = {
      // The pg lane relies on the column default (defaultRandom); mongo has
      // no such default, so the id is set explicitly.
      id: binUuid(uuidv7()),
      org_id: binUuid(input.orgId, 'orgId'),
      api_key_id: binUuid(input.apiKeyId, 'apiKeyId'),
      project_id: binUuid(input.projectId, 'projectId'),
      bound_by: binUuid(input.boundBy, 'boundBy'),
      created_at: new Date().toISOString(),
    };
    try {
      await bindings.insertOne(input.orgId, doc);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // onConflictDoNothing: the existing binding wins; nothing to do.
    }
  }

  async getBindingByKeyId(
    orgId: string,
    apiKeyId: string,
  ): Promise<ProjectKeyBindingRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // The pg lane filters on api_key_id only and lets RLS scope the
      // tenant; on the mongo lane the tenant predicate is explicit (the
      // unique index is (org_id, api_key_id), so the row is org-unique).
      const row = await t.bindings.findOne(
        orgId,
        { api_key_id: binUuid(apiKeyId, 'apiKeyId') },
        t.session,
      );
      return row ? toProjectKeyBindingRow(row) : null;
    });
  }
}
