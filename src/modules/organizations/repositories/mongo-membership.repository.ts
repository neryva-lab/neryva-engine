import type { Binary, Db, Filter } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { env } from '../../../common/config/env';
import { PlatformCollection, TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  ensureInviteIndexes,
  ensureMembershipIndexes,
  isDuplicateKey,
  nowIso,
  orgCollection,
  toMembershipRow,
  uuidOf,
} from './mongo-documents';
import type {
  AccountMongoDoc,
  EntitlementMongoDoc,
  GroupMemberMongoDoc,
  GroupMongoDoc,
  InviteMongoDoc,
  MembershipMongoDoc,
  ServiceAccountMongoDoc,
} from './mongo-documents';
import type { OrgRole } from '../schema';
import type {
  IMembershipRepository,
  MemberListRow,
  MembershipRow,
  MembershipSummary,
} from './membership.repository';
import { LAST_ACTIVE_WRITE_THRESHOLD_MS } from './membership.repository';

/**
 * Translate the exactly-one-active-owner backstop (partial unique index
 * `uq_one_active_owner_per_org`) into the stable API error — the mongo
 * twin of the pg lane's `translateOwnerInvariant` (23505 translation).
 * Every other error propagates unchanged.
 */
function translateOwnerInvariant(err: unknown): unknown {
  if (isDuplicateKey(err)) {
    return ApiError.conflict('the organization already has an active owner — transfer ownership instead', { reason: 'owner_already_present' });
  }
  return err;
}

/** Escape a user query for use in a case-insensitive regex (the mongo twin of the pg LIKE-wildcard escaping). */
function escapeRegExp(q: string): string {
  return q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MongoDB lane for `IMembershipRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` with `tenantField: 'org_id'` (plan D6) — explicit
 * org predicates everywhere, no RLS on this lane. Identity-plane reads
 * (`accounts`) use `PlatformCollection` with a justifying comment, mirroring
 * the pg lane's cross-module (non-RLS) access.
 *
 * Seat-race serialization (`addMember`): PostgreSQL serializes concurrent
 * grants with `SELECT … FOR UPDATE` on the seat-bearing entitlement rows.
 * MongoDB has no equivalent — so inside the `addMember` transaction, after
 * the seat check passes, the seat-bearing entitlement docs are write-touched
 * (`$set: { updated_at }`), making concurrent adds contend on the same
 * documents and serialize instead of both reading "under the limit".
 */
export class MongoMembershipRepository implements IMembershipRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    memberships: TenantScopedCollection<MembershipMongoDoc>;
    groupMembers: TenantScopedCollection<GroupMemberMongoDoc>;
    groups: TenantScopedCollection<GroupMongoDoc>;
    serviceAccounts: TenantScopedCollection<ServiceAccountMongoDoc>;
    entitlements: TenantScopedCollection<EntitlementMongoDoc>;
    invites: TenantScopedCollection<InviteMongoDoc>;
    accounts: PlatformCollection<AccountMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      memberships: orgCollection<MembershipMongoDoc>(db, 'org_memberships'),
      groupMembers: orgCollection<GroupMemberMongoDoc>(db, 'org_group_members'),
      groups: orgCollection<GroupMongoDoc>(db, 'org_groups'),
      serviceAccounts: orgCollection<ServiceAccountMongoDoc>(db, 'org_service_accounts'),
      entitlements: orgCollection<EntitlementMongoDoc>(db, 'product_entitlements'),
      invites: orgCollection<InviteMongoDoc>(db, 'org_invites'),
      // Identity plane (platform-plane, no RLS by schema design): read for
      // the member-inventory enrichment only, same as the pg lane's
      // cross-module `accounts` join.
      accounts: new PlatformCollection<AccountMongoDoc>(db.collection<AccountMongoDoc>('accounts')),
    };
  }

  async listMembers(
    orgId: string,
    opts?: { statuses?: string[]; q?: string; limit?: number; offset?: number },
  ): Promise<{ members: MemberListRow[]; total: number }> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const statuses = opts?.statuses && opts.statuses.length > 0 ? opts.statuses : ['active', 'suspended'];
    const q = opts?.q?.trim();

    // The pg lane ilike-filters over the JOINED accounts table (email /
    // display name). The mongo lane resolves the identity match first, then
    // filters memberships by the resulting account ids.
    const accounts = new PlatformCollection<AccountMongoDoc>(db.collection<AccountMongoDoc>('accounts'));
    let accountIds: Binary[] | undefined;
    if (q) {
      const needle = escapeRegExp(q);
      const matched = await accounts
        .find({ $or: [{ email: { $regex: needle, $options: 'i' } }, { display_name: { $regex: needle, $options: 'i' } }] })
        .toArray();
      if (matched.length === 0) {
        return { members: [], total: 0 };
      }
      accountIds = matched.map((a) => a.id);
    }

    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const filter: Filter<MembershipMongoDoc> = { status: { $in: statuses } };
      if (accountIds) {
        filter.account_id = { $in: accountIds };
      }
      const docs = await t.memberships
        .find(orgId, filter, t.session)
        .sort({ created_at: 1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      // Divergence note: pg counts the inner join (memberships whose account
      // row is missing are excluded from the total); the mongo lane counts
      // memberships and drops orphans only from the listing below. Orphaned
      // memberships cannot occur through any write path in either service,
      // so the counts agree in practice.
      const total = await t.memberships.countDocuments(orgId, filter, t.session);

      const hydrated = await t.accounts
        .find({ id: { $in: docs.map((d) => d.account_id) } }, t.session)
        .toArray();
      const byAccount = new Map(hydrated.map((a) => [uuidOf(a.id), a]));

      const groupRows = await t.groupMembers.find(orgId, {}, t.session).toArray();
      const groupDocs = await t.groups
        .find(orgId, { id: { $in: groupRows.map((r) => r.group_id) } }, t.session)
        .toArray();
      const groupNameById = new Map(groupDocs.map((g) => [uuidOf(g.id), g.name]));
      const groupsByAccount = new Map<string, Array<{ id: string; name: string }>>();
      for (const row of groupRows) {
        const name = groupNameById.get(uuidOf(row.group_id));
        if (name === undefined) continue;
        const key = uuidOf(row.account_id);
        const list = groupsByAccount.get(key) ?? [];
        list.push({ id: uuidOf(row.group_id), name });
        groupsByAccount.set(key, list);
      }

      const members: MemberListRow[] = [];
      for (const doc of docs) {
        const account = byAccount.get(uuidOf(doc.account_id));
        if (!account) continue; // inner-join semantics: drop account-less rows
        members.push({
          accountId: uuidOf(doc.account_id),
          email: account.email,
          displayName: account.display_name,
          role: doc.role as OrgRole,
          status: doc.status,
          mfaLevel: account.mfa_level,
          emailVerified: account.email_verified_at !== null,
          lastLoginAt: account.last_login_at ?? null,
          memberSince: doc.created_at,
          lastActiveAt: doc.last_active_at ?? null,
          invitedBy: doc.invited_by ? uuidOf(doc.invited_by) : null,
          suspendedAt: doc.suspended_at ?? null,
          suspendedBy: doc.suspended_by ? uuidOf(doc.suspended_by) : null,
          groups: groupsByAccount.get(uuidOf(doc.account_id)) ?? [],
        });
      }
      return { members, total };
    });
  }

  async getMember(orgId: string, accountId: string): Promise<MembershipRow | null> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.memberships.findOne(
        orgId,
        { account_id: binUuid(accountId, 'accountId') },
        t.session,
      );
      if (!row || row.status === 'removed') {
        return null;
      }
      return toMembershipRow(row);
    });
  }

  async listActiveOwners(orgId: string): Promise<MembershipRow[]> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.memberships
        .find(orgId, { role: 'owner', status: 'active' }, t.session)
        .toArray();
      return rows.map(toMembershipRow);
    });
  }

  async addMember(input: {
    orgId: string;
    accountId: string;
    role: OrgRole;
    invitedBy: string;
  }): Promise<MembershipRow> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      // AUTH-4.1 seat wall — the mongo-lane serialization story: there is
      // no SELECT … FOR UPDATE, so after the seat check passes the
      // seat-bearing entitlement docs are write-touched INSIDE this
      // transaction ($set updated_at). Two concurrent addMember calls
      // contend on the same documents and serialize; the second re-counts
      // after the first commits instead of both reading "under the limit".
      if (env.ENTITLEMENTS__SEAT_ENFORCEMENT) {
        const seatDocs = (await t.entitlements.find(input.orgId, {}, t.session).toArray())
          .filter((d) => d.seats !== null && d.seats !== undefined);
        const capped = seatDocs.filter((d) => d.status === 'trial' || d.status === 'active' || d.status === 'past_due');
        if (capped.length > 0) {
          await t.entitlements.updateMany(
            input.orgId,
            { id: { $in: capped.map((d) => d.id) } },
            { $set: { updated_at: now } },
            t.session,
          );
          const current = await t.memberships.findOne(
            input.orgId,
            { account_id: binUuid(input.accountId, 'accountId') },
            t.session,
          );
          const consumesSeat = current?.status !== 'active'; // re-activating an existing member consumes no additional seat
          if (consumesSeat) {
            const activeCount = await t.memberships.countDocuments(input.orgId, { status: 'active' }, t.session);
            const limiting = capped.find((d) => activeCount >= (d.seats ?? 0));
            if (limiting) {
              throw ApiError.seatLimitReached(limiting.product);
            }
          }
        }
      }
      // Hard cap on org size (abuse posture, not billing — seats are billing's).
      const activeTotal = await t.memberships.countDocuments(input.orgId, { status: 'active' }, t.session);
      if (activeTotal >= env.ORG_MAX_MEMBERS) {
        throw ApiError.conflict(`organization is at its member cap (${env.ORG_MAX_MEMBERS})`);
      }
      // Upsert on (account_id, org_id) — the pg onConflictDoUpdate twin.
      // $set mirrors the pg conflict target's SET clause exactly (invited_by
      // is insert-only, as on the pg lane).
      const accountBin = binUuid(input.accountId, 'accountId');
      await t.memberships.updateOne(
        input.orgId,
        { account_id: accountBin },
        {
          $set: { role: input.role, status: 'active', updated_at: now },
          $setOnInsert: {
            id: binUuid(uuidv7()),
            account_id: accountBin,
            invited_by: binUuid(input.invitedBy, 'invitedBy'),
            last_active_at: null,
            suspended_at: null,
            suspended_by: null,
            created_at: now,
          },
        },
        { ...t.session, upsert: true },
      );
      const row = await t.memberships.findOne(input.orgId, { account_id: accountBin }, t.session);
      if (!row) {
        throw new Error('mongo membership upsert did not yield a row');
      }
      return toMembershipRow(row);
    });
  }

  async setRole(orgId: string, accountId: string, role: OrgRole): Promise<void> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      try {
        await t.memberships.updateOne(
          orgId,
          { account_id: binUuid(accountId, 'accountId') },
          { $set: { role, updated_at: nowIso() } },
          t.session,
        );
      } catch (err) {
        throw translateOwnerInvariant(err);
      }
    });
  }

  async suspendMember(orgId: string, accountId: string, suspendedBy: string): Promise<void> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      await t.memberships.updateOne(
        orgId,
        { account_id: binUuid(accountId, 'accountId') },
        {
          $set: {
            status: 'suspended',
            suspended_at: now,
            suspended_by: binUuid(suspendedBy, 'suspendedBy'),
            updated_at: now,
          },
        },
        t.session,
      );
    });
  }

  async reactivateMember(orgId: string, accountId: string): Promise<void> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      try {
        await t.memberships.updateOne(
          orgId,
          { account_id: binUuid(accountId, 'accountId') },
          { $set: { status: 'active', updated_at: nowIso() } },
          t.session,
        );
      } catch (err) {
        // Defense-in-depth twin of the pg lane: the owner backstop index
        // catches a second active owner if the "suspended owners are
        // impossible" invariant ever changes.
        throw translateOwnerInvariant(err);
      }
    });
  }

  async removeMembership(orgId: string, accountId: string): Promise<void> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.memberships.updateOne(
        orgId,
        { account_id: binUuid(accountId, 'accountId') },
        { $set: { status: 'removed', updated_at: nowIso() } },
        t.session,
      );
      // Group memberships follow the member out.
      await t.groupMembers.deleteMany(
        orgId,
        { account_id: binUuid(accountId, 'accountId') },
        t.session,
      );
    });
  }

  async getRole(accountId: string, orgId: string): Promise<OrgRole | null> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    const row = await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.memberships.findOne(
        orgId,
        { account_id: binUuid(accountId, 'accountId') },
        t.session,
      );
    });
    if (!row || row.status !== 'active') {
      return null;
    }
    // Org-activity heartbeat: throttled write, fire-and-forget — it must
    // never fail the guard read (the pg lane's `void touchLastActive`).
    // The write runs in its own unit, exactly like the pg lane's separate
    // withOrg call.
    const lastActiveAt = row.last_active_at ?? null;
    const stale =
      lastActiveAt === null || Math.abs(Date.now() - Date.parse(lastActiveAt)) > LAST_ACTIVE_WRITE_THRESHOLD_MS;
    if (stale) {
      void this.mongo
        .withOrg(orgId, async (ctx) => {
          const t = this.tx(db, ctx);
          await t.memberships.updateOne(
            orgId,
            { account_id: binUuid(accountId, 'accountId') },
            { $set: { last_active_at: nowIso() } },
            t.session,
          );
        })
        .catch(() => undefined);
    }
    return row.role as OrgRole;
  }

  async listForAccount(accountId: string): Promise<MembershipRow[]> {
    // Justification (unscoped PlatformCollection read): the account's
    // memberships span orgs by definition; the query filters account_id
    // explicitly. This is the mongo twin of the pg lane's withBypass —
    // without RLS there is no bypass flag to set, so a direct unscoped
    // read on the root handle is the equivalent. Single read: no
    // transaction needed.
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    const memberships = new PlatformCollection<MembershipMongoDoc>(db.collection<MembershipMongoDoc>('org_memberships'));
    const rows = await memberships
      .find({ account_id: binUuid(accountId, 'accountId'), status: 'active' })
      .toArray();
    return rows.map(toMembershipRow);
  }

  async summary(orgId: string): Promise<MembershipSummary> {
    const db = this.mongo.root;
    await ensureMembershipIndexes(db);
    await ensureInviteIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      const statusRows = (await t.memberships
        .aggregate(orgId, [{ $group: { _id: '$status', n: { $sum: 1 } } }], t.session)
        .toArray()) as unknown as Array<{ _id: string; n: number }>;
      const statusCount = new Map(statusRows.map((r) => [String(r._id), Number(r.n)]));
      const active = statusCount.get('active') ?? 0;
      const suspended = statusCount.get('suspended') ?? 0;

      // Pending is computed (not-yet-accepted, not-revoked, not-expired) so
      // it can never drift from the token state. `{ x: null }` matches both
      // null and missing, mirroring pg `IS NULL`.
      const pendingInvites = await t.invites.countDocuments(
        orgId,
        { accepted_at: null, revoked_at: null, expires_at: { $gt: now } },
        t.session,
      );

      const saRows = (await t.serviceAccounts
        .aggregate(orgId, [{ $group: { _id: '$status', n: { $sum: 1 } } }], t.session)
        .toArray()) as unknown as Array<{ _id: string; n: number }>;
      const saCount = new Map(saRows.map((r) => [String(r._id), Number(r.n)]));
      const groups = await t.groups.countDocuments(orgId, {}, t.session);
      const entitlementDocs = await t.entitlements.find(orgId, {}, t.session).toArray();

      return {
        members: { total: active + suspended, active, suspended },
        pendingInvites,
        serviceAccounts: {
          total: (saCount.get('active') ?? 0) + (saCount.get('disabled') ?? 0),
          active: saCount.get('active') ?? 0,
        },
        groups,
        seats: entitlementDocs.map((d) => ({
          product: d.product,
          plan: d.plan,
          seats: d.seats ?? null,
          activeMembers: active,
          utilization: d.seats && d.seats > 0 ? Math.round((active / d.seats) * 100) / 100 : null,
          state: d.status,
        })),
      };
    });
  }
}
