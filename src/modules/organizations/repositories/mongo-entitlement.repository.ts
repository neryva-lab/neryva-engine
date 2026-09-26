/**
 * MongoDB lane for `IEntitlementRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` via `orgCollection` (plan D6, tenant key
 * `org_id`).
 *
 * The write half preserves the service's read-then-upsert shape: the
 * service reads via `getEntitlement` first; `upsertEntitlement` is the
 * upsert only (insert-with-defaults + conditional update, then read back —
 * the mongo equivalent of pg's `onConflictDoUpdate … returning`).
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  ensureFurnitureIndexes,
  nowIso,
  orgCollection,
  toProductEntitlementRow,
} from './mongo-documents';
import type { ProductEntitlementDoc } from './mongo-documents';
import type { EntitlementRow, IEntitlementRepository } from './entitlement.repository';

export class MongoEntitlementRepository implements IEntitlementRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    entitlements: TenantScopedCollection<ProductEntitlementDoc>;
  } {
    return {
      session: { session: ctx.session },
      entitlements: orgCollection<ProductEntitlementDoc>(db, 'product_entitlements'),
    };
  }

  /** Raw row read; the service maps a miss to the virtual `none` state. */
  async getEntitlement(orgId: string, product: string): Promise<EntitlementRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.entitlements.findOne(orgId, { product }, t.session);
      return doc ? toProductEntitlementRow(doc) : null;
    });
  }

  /** All entitlement rows for the org. */
  async listEntitlements(orgId: string): Promise<EntitlementRow[]> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.entitlements.find(orgId, {}, t.session).toArray();
      return docs.map(toProductEntitlementRow);
    });
  }

  /**
   * The write half of the service's read-then-upsert `transition`: the
   * service performs the read via `getEntitlement` first — the two-step
   * shape is preserved, not merged into a single upsert. `$set` carries the
   * conditional updates (plus `updated_at`, always); `$setOnInsert` carries
   * the pg insert defaults; the post-write row is read back, mirroring
   * `onConflictDoUpdate … returning`.
   */
  async upsertEntitlement(input: {
    orgId: string;
    product: string;
    target: 'trial' | 'active' | 'past_due' | 'suspended' | 'expired';
    plan?: string;
    limits?: Record<string, unknown>;
    seats?: number | null;
    period?: { start: string; end: string };
    source?: string;
  }): Promise<EntitlementRow> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      const filter = { product: input.product };
      // `$set` carries the conditional updates (plus `updated_at`, always).
      // `$setOnInsert` carries the pg column defaults ONLY for the fields
      // absent from `$set` — Mongo rejects a path present in both operators,
      // so the two objects are built disjointly. The defaults mirror the pg
      // insert exactly: plan ?? 'default', limits ?? {}, seats/source/period
      // omitted → null.
      const set: Record<string, unknown> = { status: input.target, updated_at: now };
      const setOnInsert: Record<string, unknown> = {
        id: binUuid(uuidv7()),
        org_id: binUuid(input.orgId, 'orgId'),
        product: input.product,
        created_at: now,
      };
      if (input.plan) {
        set.plan = input.plan;
      } else {
        setOnInsert.plan = 'default';
      }
      if (input.limits) {
        set.limits = input.limits;
      } else {
        setOnInsert.limits = {};
      }
      if (input.seats !== undefined) {
        set.seats = input.seats;
      } else {
        setOnInsert.seats = null;
      }
      if (input.source) {
        set.source = input.source;
      } else {
        setOnInsert.source = null;
      }
      if (input.period) {
        set.period_start = input.period.start;
        set.period_end = input.period.end;
      } else {
        setOnInsert.period_start = null;
        setOnInsert.period_end = null;
      }
      await t.entitlements.updateOne(
        input.orgId,
        filter,
        { $set: set, $setOnInsert: setOnInsert },
        { ...t.session, upsert: true },
      );
      const doc = await t.entitlements.findOne(input.orgId, filter, t.session);
      if (!doc) {
        throw new Error('mongo entitlement upsert: row missing after upsert');
      }
      return toProductEntitlementRow(doc);
    });
  }
}
