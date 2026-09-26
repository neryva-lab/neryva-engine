/**
 * MongoDB lane for `IPlatformStaffRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Platform-plane (no tenant scoping) — every
 * operation runs under `withBypass` with explicit filters, exactly the pg
 * lane's `db.root` posture.
 *
 * The upsert is an atomic `updateOne` with `upsert: true` (never a
 * catch-duplicate-key-then-update inside the transaction — the pg lane's
 * `onConflictDoUpdate` semantics without the aborted-transaction trap).
 * The staff list's accounts left-join is two collection reads.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type {
  IPlatformStaffRepository,
  PlatformStaff,
  PlatformStaffListRow,
  UpsertPlatformStaffInput,
} from './platform-staff.repository';
import {
  binUuid,
  toPlatformStaff,
  toPlatformStaffListRow,
  type AccountPlaneMongoDoc,
  type PlatformStaffMongoDoc,
} from './mongo-documents';

export class MongoPlatformStaffRepository implements IPlatformStaffRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private staff(db: Db) {
    return db.collection<PlatformStaffMongoDoc>('platform_staff');
  }

  private accounts(db: Db) {
    return db.collection<AccountPlaneMongoDoc>('accounts');
  }

  private sessionOpt(ctx: MongoTxContext) {
    return { session: ctx.session };
  }

  async upsert(input: UpsertPlatformStaffInput): Promise<PlatformStaff[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const coll = this.staff(db);
      const accountId = binUuid(input.accountId, 'accountId');
      // Atomic upsert: insert-or-replace the binding, clearing any prior
      // revocation — the pg lane's `onConflictDoUpdate` semantics.
      await coll.updateOne(
        { account_id: accountId },
        {
          $set: {
            role: input.role,
            granted_by: input.grantedBy ? binUuid(input.grantedBy, 'grantedBy') : null,
            granted_at: input.nowIso,
            expires_at: input.expiresAt,
            revoked_at: null,
            revoke_reason: null,
          },
          $setOnInsert: { account_id: accountId },
        },
        { ...this.sessionOpt(ctx), upsert: true },
      );
      const doc = await coll.findOne({ account_id: accountId }, this.sessionOpt(ctx));
      if (!doc) {
        throw new Error('platform_staff upsert failed to return the row');
      }
      return [toPlatformStaff(doc)];
    });
  }

  async findByAccountId(accountId: string): Promise<PlatformStaff | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const doc = await this.staff(db).findOne(
        { account_id: binUuid(accountId, 'accountId') },
        this.sessionOpt(ctx),
      );
      return doc ? toPlatformStaff(doc) : null;
    });
  }

  async revoke(accountId: string, reason: string | null, nowIso: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      await this.staff(db).updateOne(
        { account_id: binUuid(accountId, 'accountId') },
        { $set: { revoked_at: nowIso, revoke_reason: reason } },
        this.sessionOpt(ctx),
      );
    });
  }

  async list(): Promise<PlatformStaffListRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const rows = await this.staff(db).find({}, this.sessionOpt(ctx)).toArray();
      if (rows.length === 0) {
        return [];
      }
      const accountIds = rows.map((r) => r.account_id);
      const accountDocs = await this.accounts(db)
        .find({ id: { $in: accountIds } }, this.sessionOpt(ctx))
        .toArray();
      const byId = new Map(accountDocs.map((a) => [a.id.toUUID().toString(), a]));
      return rows.map((r) => toPlatformStaffListRow(r, byId.get(r.account_id.toUUID().toString()) ?? null));
    });
  }

  async countActiveSuperAdmins(nowIso: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      return this.staff(db).countDocuments(
        {
          role: 'super_admin',
          revoked_at: null,
          $or: [{ expires_at: null }, { expires_at: { $gt: nowIso } }],
        },
        this.sessionOpt(ctx),
      );
    });
  }
}
