/**
 * MongoDB lane for `IWebhookRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate (`org_id`) is enforced
 * by `TenantScopedCollection` (plan D6). Mongo does NOT apply pg column
 * defaults — `id` (uuidv7), `status`, `created_at`, `updated_at` are set
 * explicitly on every insert.
 *
 * Shared helpers (typed document shapes, `binUuid`) live in
 * `./mongo-documents.ts`.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { WebhookRow } from '../schema';
import {
  binUuid,
  tenantCollection,
  toWebhook,
  type WebhookDeliveryMongoDoc,
  type WebhookMongoDoc,
} from './mongo-documents';
import type {
  CreateWebhookInput,
  IWebhookRepository,
  WebhookUpdatePatch,
} from './webhooks.repository';

export class MongoWebhookRepository implements IWebhookRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return {
      session: { session: ctx.session },
      webhooks: tenantCollection<WebhookMongoDoc>(db, 'webhooks'),
      deliveries: tenantCollection<WebhookDeliveryMongoDoc>(db, 'webhook_deliveries'),
    };
  }

  /** Insert a webhook row (one withOrg unit); returns the raw row. */
  async createWebhook(input: CreateWebhookInput): Promise<WebhookRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = new Date().toISOString();
      // pg `defaultRandom()`/`defaultNow()` do not exist on this lane — every
      // field is set explicitly (uuidv7 keeps the time-sortable id contract).
      const doc: WebhookMongoDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(input.orgId, 'orgId'),
        events: input.events,
        url: input.url,
        secret_envelope: input.secretEnvelope,
        description: input.description ?? null,
        status: 'active',
        created_by: null,
        created_at: now,
        updated_at: now,
      };
      await t.webhooks.insertOne(input.orgId, doc, t.session);
      return toWebhook(doc);
    });
  }

  /** Raw row read (withOrg); the service applies the notFound mapping. */
  async getWebhook(orgId: string, webhookId: string): Promise<WebhookRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.webhooks.findOne(orgId, { id: binUuid(webhookId, 'webhookId') }, t.session);
      return row ? toWebhook(row) : null;
    });
  }

  /**
   * Bypass read by id (the worker drains the cross-org queue — the hook is
   * addressed by its unique id, no tenant scope). `unsafeNative` with an
   * explicit id predicate; safe because the caller holds the unguessable
   * delivery→webhook id binding from the queued job.
   */
  async getWebhookUnchecked(webhookId: string): Promise<WebhookRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.webhooks.unsafeNative.findOne(
        { id: binUuid(webhookId, 'webhookId') },
        { session: ctx.session },
      );
      return row ? toWebhook(row) : null;
    });
  }

  /** All webhooks of an org, newest first. */
  async listWebhooks(orgId: string): Promise<WebhookRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.webhooks.find(orgId, {}, t.session).sort({ created_at: -1 }).toArray();
      return rows.map(toWebhook);
    });
  }

  /** Subscribed + active targets for the dispatch fan-out. */
  async listActiveWebhooks(orgId: string): Promise<WebhookRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.webhooks.find(orgId, { status: 'active' }, t.session).toArray();
      return rows.map(toWebhook);
    });
  }

  /**
   * Patch a webhook row (one withOrg unit). Returns null when the row is
   * gone (the service maps this to notFound).
   */
  async updateWebhook(orgId: string, webhookId: string, patch: WebhookUpdatePatch): Promise<WebhookRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.webhooks.findOneAndUpdate(
        orgId,
        { id: binUuid(webhookId, 'webhookId') },
        { $set: toMongoPatch(patch) },
        { ...t.session, returnDocument: 'after' },
      );
      // Mirrors the pg `updated[0]`: undefined at runtime when the row
      // vanished between require and update (the known require/update race).
      return (updated ? toWebhook(updated) : undefined) as WebhookRow;
    });
  }

  /** Delete a webhook row (cascade drops its deliveries). */
  async deleteWebhook(orgId: string, webhookId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.webhooks.deleteOne(orgId, { id: binUuid(webhookId, 'webhookId') }, t.session);
      // pg's `onDelete: 'cascade'` does not exist on this lane — delete the
      // webhook's deliveries in the same tenant unit (tenant-scoped, so no
      // other org's rows are ever touched).
      await t.deliveries.deleteMany(orgId, { webhook_id: binUuid(webhookId, 'webhookId') }, t.session);
    });
  }

  /** Rotate the signing secret (old one dies immediately). */
  async rotateSecret(orgId: string, webhookId: string, secretEnvelope: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.webhooks.updateOne(
        orgId,
        { id: binUuid(webhookId, 'webhookId') },
        { $set: { secret_envelope: secretEnvelope, updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }
}

/** Map the camelCase service patch to snake_case document fields. */
function toMongoPatch(patch: WebhookUpdatePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.url !== undefined) out.url = patch.url;
  if (patch.events !== undefined) out.events = patch.events;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.secretEnvelope !== undefined) out.secret_envelope = patch.secretEnvelope;
  if (patch.createdBy !== undefined) out.created_by = patch.createdBy ? binUuid(patch.createdBy, 'createdBy') : null;
  if (patch.updatedAt !== undefined) out.updated_at = patch.updatedAt;
  if (patch.orgId !== undefined) out.org_id = binUuid(patch.orgId, 'orgId');
  return out;
}
