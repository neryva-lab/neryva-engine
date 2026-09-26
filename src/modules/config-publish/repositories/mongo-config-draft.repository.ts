/**
 * MongoDB lane for `IConfigDraftRepository` (P3) — the mutable draft layer.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Mongo applies no
 * column defaults, so every field is set explicitly on upsert-insert (pg
 * `defaultRandom()`/`defaultNow()` have no counterpart here).
 *
 * Tenant discipline: every access goes through `TenantScopedCollection`
 * with the `org_id` tenant field (the org-furniture group). The draft
 * upsert is a single atomic `findOneAndUpdate` with `upsert: true` keyed on
 * (org_id, scope, product) — the mongo unique index
 * `uq_config_drafts_key`; a null product matches the null-product doc, the
 * mongo equivalent of the pg lane's NULLS NOT DISTINCT upsert.
 *
 * The service keeps: input validation, payload validation, the
 * post-publish cleanup's error swallowing, and audit writes.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ConfigDraft, ConfigScope } from '../config-publish.schema';
import type { IConfigDraftRepository, SaveDraftInput } from './config-publish.repository';
import {
  binUuid,
  tenantCollection,
  toConfigDraft,
  type ConfigDraftMongoDoc,
} from './mongo-documents';

export class MongoConfigDraftRepository implements IConfigDraftRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    drafts: TenantScopedCollection<ConfigDraftMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      drafts: tenantCollection<ConfigDraftMongoDoc>(db, 'config_drafts'),
    };
  }

  /**
   * Save (upsert) the draft for a key in ONE `withOrg` unit: an atomic
   * `findOneAndUpdate` with `upsert: true` on (org_id, scope, product).
   * `created_by`/`created_at` are set on insert only (`$setOnInsert`).
   * Drafts keep the RAW payload (not the normalized one) so the author sees
   * exactly what they typed; publish normalizes on the way out.
   */
  async saveDraft(input: SaveDraftInput): Promise<ConfigDraft> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const t = this.tx(db, ctx);
      const now = new Date().toISOString();
      const updated = await t.drafts.findOneAndUpdate(
        input.orgId,
        { scope: input.scope, product: input.product },
        {
          $set: {
            payload: input.payload,
            payload_hash: input.payloadHash,
            validation_status: input.validationStatus,
            validation_issues: input.validationIssues,
            notes: input.notes,
            updated_by: input.updatedBy,
            updated_at: now,
          },
          $setOnInsert: {
            id: binUuid(uuidv7()),
            org_id: binUuid(input.orgId, 'orgId'),
            scope: input.scope,
            product: input.product,
            created_by: input.updatedBy,
            created_at: now,
          },
        },
        { ...t.session, upsert: true, returnDocument: 'after' },
      );
      if (!updated) {
        throw new Error('config-publish: draft upsert returned no document');
      }
      return toConfigDraft(updated);
    });
  }

  /** The one draft for a key (null when absent). */
  async getDraft(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<ConfigDraft | null> {
    const db = this.mongo.root;
    const drafts = tenantCollection<ConfigDraftMongoDoc>(db, 'config_drafts');
    const doc = await drafts.findOne(orgId, { scope, product });
    return doc ? toConfigDraft(doc) : null;
  }

  /** Every draft for the org, ordered by (scope, product). */
  async listDrafts(orgId: string): Promise<ConfigDraft[]> {
    const db = this.mongo.root;
    const drafts = tenantCollection<ConfigDraftMongoDoc>(db, 'config_drafts');
    const docs = await drafts.find(orgId, {}, { sort: { scope: 1, product: 1 } }).toArray();
    return docs.map(toConfigDraft);
  }

  /** Delete the draft for a key; returns the deleted id (null when absent). */
  async deleteDraft(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<{ id: string } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const t = this.tx(db, ctx);
      const deleted = await t.drafts.findOneAndDelete(
        orgId,
        { scope, product },
        t.session,
      );
      return deleted ? { id: deleted.id.toUUID().toString() } : null;
    });
  }

  /**
   * Delete the draft for a key only if its payload hash still matches —
   * the post-publish cleanup (a concurrent edit keeps the draft alive).
   * Never throws when nothing matches.
   */
  async deleteDraftIfPayloadMatches(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    payloadHash: string,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const t = this.tx(db, ctx);
      await t.drafts.deleteOne(
        orgId,
        { scope, product, payload_hash: payloadHash },
        t.session,
      );
    });
  }
}
