/**
 * MongoDB lane for `IGroupRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` via `orgCollection` (plan D6, tenant key
 * `org_id`). The unique (org_id, name) and (group_id, account_id) indexes
 * are ensured defensively here (plan D7); 11000 maps to the identical
 * ApiError.conflict the pg lane returns.
 *
 * The member-inventory join (`listGroupMembers`) is a `$lookup` pipeline
 * with `$unwind` (no `preserveNullAndEmptyArrays`) — the exact mongo
 * equivalent of the pg inner joins: members without a matching account or
 * membership row drop out, and the group's own tenant scope rides the
 * aggregate's prepended `$match`.
 */
import type { Binary, Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  DuplicateKeySignal,
  ensureFurnitureIndexes,
  isDuplicateKey,
  nowIso,
  orgCollection,
  toOrgGroupRow,
  uuidOf,
} from './mongo-documents';
import type { OrgGroupDoc, OrgGroupMemberDoc } from './mongo-documents';
import type {
  GroupListEntry,
  GroupMemberDetail,
  GroupRow,
  IGroupRepository,
} from './group.repository';

export class MongoGroupRepository implements IGroupRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    groups: TenantScopedCollection<OrgGroupDoc>;
    members: TenantScopedCollection<OrgGroupMemberDoc>;
  } {
    return {
      session: { session: ctx.session },
      groups: orgCollection<OrgGroupDoc>(db, 'org_groups'),
      members: orgCollection<OrgGroupMemberDoc>(db, 'org_group_members'),
    };
  }

  /** All groups of the org with member counts, ordered by name. */
  async listGroups(orgId: string): Promise<GroupListEntry[]> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // Left-join member counts (group ids are globally unique, so the
      // lookup needs no org predicate of its own). `aggregate` returns
      // AggregationCursor<OrgGroupDoc> (no type parameter) — the projected
      // shape is asserted via the cast below.
      const rows = (await t.groups
        .aggregate(
          orgId,
          [
            {
              $lookup: {
                from: 'org_group_members',
                localField: 'id',
                foreignField: 'group_id',
                as: '_members',
              },
            },
            {
              $project: {
                _doc: '$$ROOT',
                member_count: { $size: '$_members' },
              },
            },
            { $sort: { '_doc.name': 1 } },
          ],
          t.session,
        )
        .toArray()) as unknown as Array<{ _doc: OrgGroupDoc; member_count: number }>;
      return rows.map((row) => {
        const group = toOrgGroupRow(row._doc);
        return {
          id: group.id,
          name: group.name,
          description: group.description,
          memberCount: row.member_count,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        };
      });
    });
  }

  /** Raw read + member count; the service maps a miss to NotFoundException. */
  async getGroup(orgId: string, groupId: string): Promise<GroupListEntry | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.groups.findOne(orgId, { id: binUuid(groupId, 'groupId') }, t.session);
      if (!doc) {
        return null;
      }
      const memberCount = await t.members.countDocuments(
        orgId,
        { group_id: binUuid(groupId, 'groupId') },
        t.session,
      );
      const group = toOrgGroupRow(doc);
      return {
        id: group.id,
        name: group.name,
        description: group.description,
        memberCount,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      };
    });
  }

  /**
   * Insert a group. The unique (org_id, name) index is the guard — null on
   * 11000, which the service maps to ApiError.conflict (identical to the
   * pg `onConflictDoNothing` → empty returning shape).
   */
  async createGroup(input: {
    orgId: string;
    name: string;
    description: string | null;
    createdBy: string;
  }): Promise<GroupRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const now = nowIso();
        const doc: OrgGroupDoc = {
          id: binUuid(uuidv7()),
          org_id: binUuid(input.orgId, 'orgId'),
          name: input.name,
          description: input.description,
          created_by: binUuid(input.createdBy, 'createdBy'),
          created_at: now,
          updated_at: now,
        };
        try {
          await t.groups.insertOne(input.orgId, doc, t.session);
        } catch (err) {
          // Duplicate → sentinel, NOT a normal return: the failed write
          // aborts the transaction and withTransaction would retry forever.
          if (isDuplicateKey(err)) throw new DuplicateKeySignal();
          throw err;
        }
        return toOrgGroupRow(doc);
      });
    } catch (err) {
      if (err instanceof DuplicateKeySignal) return null;
      throw err;
    }
  }

  /**
   * Rename / re-describe. A rename onto an existing (org_id, name) trips
   * the unique index — 11000 maps to the same stable 409 the create path
   * returns (identical to the pg lane's 23505 mapping).
   */
  async updateGroup(input: {
    orgId: string;
    groupId: string;
    name?: string;
    description?: string | null;
    updatedAt: string;
  }): Promise<GroupRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const set: Record<string, unknown> = { updated_at: input.updatedAt };
      if (input.name !== undefined) {
        set.name = input.name;
      }
      if (input.description !== undefined) {
        set.description = input.description;
      }
      let matched: number;
      try {
        const result = await t.groups.updateOne(
          input.orgId,
          { id: binUuid(input.groupId, 'groupId') },
          { $set: set },
          t.session,
        );
        matched = result.matchedCount;
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw ApiError.conflict('a group with that name exists in this organization');
        }
        throw err;
      }
      if (matched === 0) {
        return null;
      }
      const doc = await t.groups.findOne(input.orgId, { id: binUuid(input.groupId, 'groupId') }, t.session);
      return doc ? toOrgGroupRow(doc) : null;
    });
  }

  /** Delete the group and all its members atomically (one transaction). */
  async removeGroup(orgId: string, groupId: string): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const gid = binUuid(groupId, 'groupId');
      await t.members.deleteMany(orgId, { group_id: gid }, t.session);
      await t.groups.deleteOne(orgId, { id: gid }, t.session);
    });
  }

  /**
   * Members with account email/displayName + org role, oldest first — the
   * mongo equivalent of the pg inner joins (unmatched rows drop out).
   */
  async listGroupMembers(orgId: string, groupId: string): Promise<GroupMemberDetail[]> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // `aggregate` returns AggregationCursor<OrgGroupMemberDoc> (no type
      // parameter) — the joined projection shape is asserted via the cast.
      const rows = (await t.members
        .aggregate(
          orgId,
          [
            { $match: { group_id: binUuid(groupId, 'groupId') } },
            { $sort: { added_at: 1 } },
            {
              $lookup: {
                from: 'accounts',
                localField: 'account_id',
                foreignField: 'id',
                as: '_account',
              },
            },
            { $unwind: '$_account' },
            {
              $lookup: {
                from: 'org_memberships',
                let: { aid: '$account_id', oid: '$org_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ['$account_id', '$$aid'] },
                          { $eq: ['$org_id', '$$oid'] },
                        ],
                      },
                    },
                  },
                ],
                as: '_membership',
              },
            },
            { $unwind: '$_membership' },
            {
              $project: {
                _id: 0,
                account_id: 1,
                added_at: 1,
                email: '$_account.email',
                display_name: '$_account.display_name',
                role: '$_membership.role',
              },
            },
          ],
          t.session,
        )
        .toArray()) as unknown as Array<{
        account_id: Binary;
        added_at: string;
        email: string;
        display_name: string | null;
        role: string;
      }>;
      return rows.map((row) => ({
        accountId: uuidOf(row.account_id),
        email: row.email,
        displayName: row.display_name ?? null,
        role: row.role,
        addedAt: row.added_at,
      }));
    });
  }

  /**
   * Add a member. False on replay of the (group_id, account_id) pair —
   * 11000 on the unique index — which the service maps to
   * ApiError.conflict. Deliberately NOT idempotent: a replay is a 409,
   * matching the pg `onConflictDoNothing` shape.
   */
  async addGroupMember(input: {
    orgId: string;
    groupId: string;
    accountId: string;
    addedBy: string;
  }): Promise<boolean> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const doc: OrgGroupMemberDoc = {
          group_id: binUuid(input.groupId, 'groupId'),
          account_id: binUuid(input.accountId, 'accountId'),
          org_id: binUuid(input.orgId, 'orgId'),
          added_by: binUuid(input.addedBy, 'addedBy'),
          added_at: nowIso(),
        };
        try {
          await t.members.insertOne(input.orgId, doc, t.session);
          return true;
        } catch (err) {
          // Duplicate → sentinel, NOT a normal return: the failed write
          // aborts the transaction and withTransaction would retry forever.
          if (isDuplicateKey(err)) throw new DuplicateKeySignal();
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof DuplicateKeySignal) return false;
      throw err;
    }
  }

  /** Remove a member; false when the membership row is absent. */
  async removeGroupMember(input: {
    orgId: string;
    groupId: string;
    accountId: string;
  }): Promise<boolean> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const result = await t.members.deleteOne(
        input.orgId,
        {
          group_id: binUuid(input.groupId, 'groupId'),
          account_id: binUuid(input.accountId, 'accountId'),
        },
        t.session,
      );
      return result.deletedCount === 1;
    });
  }
}
