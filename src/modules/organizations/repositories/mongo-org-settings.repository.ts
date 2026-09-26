/**
 * MongoDB lane for `IOrgSettingsRepository` (P3) — the engine-owned
 * `org_settings` row only. The Python-owned `tenants` seam is NOT here; it
 * goes through `IOrgInfoRepository` in the service.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` via `orgCollection` (plan D6, tenant key
 * `org_id`). `ensureRow` is insert-if-absent-then-read (`updateOne` with
 * `$setOnInsert` + upsert, then read); `updateSettings` upserts the supplied
 * keys with `$set` and the pg column defaults with `$setOnInsert`.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import {
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  ensureFurnitureIndexes,
  nowIso,
  orgCollection,
  toOrgSettingsRow,
} from './mongo-documents';
import type { OrgSettingsDoc } from './mongo-documents';
import type { IOrgSettingsRepository, OrgSettingsRow } from './org-settings.repository';

export class MongoOrgSettingsRepository implements IOrgSettingsRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    settings: TenantScopedCollection<OrgSettingsDoc>;
  } {
    return {
      session: { session: ctx.session },
      settings: orgCollection<OrgSettingsDoc>(db, 'org_settings'),
    };
  }

  /**
   * Settings row read, creating the lazy default on first touch:
   * insert-if-absent (`$setOnInsert` + upsert), then read. An existing row
   * is returned untouched (`updated_at` does NOT move).
   */
  async ensureRow(orgId: string): Promise<OrgSettingsRow> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      await t.settings.updateOne(
        orgId,
        {},
        {
          $setOnInsert: {
            org_id: binUuid(orgId, 'orgId'),
            kind: 'personal',
            support_email: null,
            default_project_id: null,
            branding: {},
            preferences: {},
            created_at: now,
            updated_at: now,
          },
        },
        { ...t.session, upsert: true },
      );
      const doc = await t.settings.findOne(orgId, {}, t.session);
      if (!doc) {
        throw new Error('mongo org_settings ensureRow: row missing after upsert');
      }
      return toOrgSettingsRow(doc);
    });
  }

  /**
   * Upsert presentation state — `$set` carries the supplied keys (plus
   * `updated_at`, always); `$setOnInsert` carries the pg column defaults
   * for the keys the caller did NOT supply, so an insert produces the same
   * row the pg lane's column defaults produce. Branding/preferences arrive
   * pre-merged by the service; the repository sets them whole.
   */
  async updateSettings(
    orgId: string,
    update: {
      supportEmail?: string | null;
      defaultProjectId?: string | null;
      branding?: Record<string, unknown>;
      preferences?: Record<string, unknown>;
      updatedAt: string;
    },
  ): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      const set: Record<string, unknown> = { updated_at: update.updatedAt };
      const setOnInsert: Record<string, unknown> = {
        org_id: binUuid(orgId, 'orgId'),
        kind: 'personal',
        created_at: now,
      };
      if (update.supportEmail !== undefined) {
        set.support_email = update.supportEmail;
      } else {
        setOnInsert.support_email = null;
      }
      if (update.defaultProjectId !== undefined) {
        set.default_project_id = update.defaultProjectId ? binUuid(update.defaultProjectId, 'defaultProjectId') : null;
      } else {
        setOnInsert.default_project_id = null;
      }
      if (update.branding !== undefined) {
        set.branding = update.branding;
      } else {
        setOnInsert.branding = {};
      }
      if (update.preferences !== undefined) {
        set.preferences = update.preferences;
      } else {
        setOnInsert.preferences = {};
      }
      await t.settings.updateOne(
        orgId,
        {},
        { $set: set, $setOnInsert: setOnInsert },
        { ...t.session, upsert: true },
      );
    });
  }
}
