import type { Db } from 'mongodb';
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
  toInviteRow,
  uuidOf,
} from './mongo-documents';
import type {
  AccountMongoDoc,
  InviteCreateLockMongoDoc,
  InviteMongoDoc,
  MembershipMongoDoc,
} from './mongo-documents';
import type { IInviteRepository, InviteRow } from './invite.repository';

/**
 * MongoDB lane for `IInviteRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` with `tenantField: 'org_id'` (plan D6) — explicit
 * org predicates everywhere, no RLS on this lane. The cross-tenant
 * token-path reads (`getInviteById`) and the attempt counter
 * (`registerAttempt`) use deliberately unscoped `PlatformCollection` access
 * with justifying comments, mirroring the pg lane's `withBypass`/`root`
 * escape hatches. The identity-plane `accounts` read (invite member guard)
 * is likewise platform-plane.
 *
 * Invite-creation race (concurrency patch): pg serializes per (org, email)
 * with `pg_advisory_xact_lock`. MongoDB has no advisory locks — the twin is
 * a lock doc in `org_invite_create_locks` (`_id` =
 * `invite-create:<orgId>:<lower email>`; single-doc insert atomicity means
 * exactly one concurrent creator wins). The winner runs the guarded unit;
 * the loser re-reads the winner's committed row and replays it
 * idempotently (`created: false`). The lock doc is deleted in a `finally`;
 * a TTL index reaps it if the process dies mid-create.
 */
export class MongoInviteRepository implements IInviteRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    invites: TenantScopedCollection<InviteMongoDoc>;
    memberships: TenantScopedCollection<MembershipMongoDoc>;
    accounts: PlatformCollection<AccountMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      invites: orgCollection<InviteMongoDoc>(db, 'org_invites'),
      memberships: orgCollection<MembershipMongoDoc>(db, 'org_memberships'),
      // Identity plane (platform-plane, no RLS by schema design): the
      // invite member guard resolves email → account id, same as the pg
      // lane's `(select id from accounts where email = …)` subselect.
      accounts: new PlatformCollection<AccountMongoDoc>(db.collection<AccountMongoDoc>('accounts')),
    };
  }

  async createInvite(input: {
    orgId: string;
    email: string;
    role: string;
    invitedBy: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<{ invite: InviteRow; created: boolean }> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    await ensureMembershipIndexes(db);
    // The email is normalized (lowercased) by the service; lower() again for
    // the lock key so the serializer cannot be split by case.
    const email = input.email.toLowerCase();
    const lockId = `invite-create:${input.orgId}:${email}`;
    const locks = new PlatformCollection<InviteCreateLockMongoDoc>(
      db.collection<InviteCreateLockMongoDoc>('org_invite_create_locks'),
    );
    let lockAcquired = false;
    try {
      // Single-doc insert atomicity is the serializer: exactly one
      // concurrent creator wins the lock per (org, email).
      await locks.insertOne({ _id: lockId, created_at: nowIso() });
      lockAcquired = true;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Lost the race — the winner is mid-create. Poll briefly for its
      // committed row and replay it idempotently; if nothing appears, fail
      // closed with the pending conflict (the winner may have failed a
      // guard, in which case the caller retries and takes the normal path).
      const raced = await this.pollPendingInvite(db, input.orgId, email, lockId);
      if (raced) {
        return { invite: raced, created: false };
      }
      throw ApiError.conflict('an invitation for this email is already pending — resend or revoke it');
    }

    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const now = nowIso();
        // Guard: the email is already an active member.
        // Guard: a suspended member already holds a (deactivated) membership
        // row — inviting them would silently reactivate via the addMember
        // upsert. Reject with the reactivate path instead.
        const account = await t.accounts.findOne({ email }, { session: ctx.session });
        if (account) {
          const prior = await t.memberships.findOne(
            input.orgId,
            { account_id: account.id },
            t.session,
          );
          if (prior?.status === 'active') {
            throw ApiError.conflict('this email is already a member of the organization');
          }
          if (prior?.status === 'suspended') {
            throw ApiError.conflict('this email belongs to a suspended member — reactivate them in the Members tab instead', {
              reason: 'member_suspended',
            });
          }
        }

        // Guard: one usable invite per (org, email) — revoke it first to
        // re-issue. Inside the lock this doubles as the race recheck: a
        // pending row observed here is REPLAYED, never duplicated. (On the
        // pg lane the recheck is a separate step after the advisory lock;
        // here the lock doc already excludes a concurrent insert, so the
        // guard IS the recheck.) Idempotent replay: the existing invite is
        // returned with `created: false` — no new token is minted, so the
        // service cannot return an accept_url for the replay.
        const pending = await t.invites.findOne(
          input.orgId,
          { email, accepted_at: null, revoked_at: null, expires_at: { $gt: now } },
          t.session,
        );
        if (pending) {
          return { invite: toInviteRow(pending), created: false };
        }

        // Guard: pending-invite ceiling (typo/abuse posture).
        const pendingCount = await t.invites.countDocuments(
          input.orgId,
          { accepted_at: null, revoked_at: null, expires_at: { $gt: now } },
          t.session,
        );
        if (pendingCount >= env.ORG_MAX_PENDING_INVITES) {
          throw ApiError.conflict(`the organization is at its pending-invitation cap (${env.ORG_MAX_PENDING_INVITES})`);
        }

        const inviteId = uuidv7();
        const doc: InviteMongoDoc = {
          id: binUuid(inviteId),
          org_id: binUuid(input.orgId, 'orgId'),
          email,
          role: input.role,
          token_hash: input.tokenHash,
          invited_by: binUuid(input.invitedBy, 'invitedBy'),
          expires_at: input.expiresAt,
          accepted_at: null,
          attempts: 0,
          revoked_at: null,
          resend_count: 0,
          created_at: now,
          updated_at: now,
        };
        await t.invites.insertOne(input.orgId, doc, t.session);
        return { invite: toInviteRow(doc), created: true };
      });
    } finally {
      if (lockAcquired) {
        await locks.deleteOne({ _id: lockId }).catch(() => undefined);
      }
    }
  }

  /**
   * The lock loser polls for the winner's committed row. The row becomes
   * visible at the winner's commit; poll for up to ~3s (covers a slow
   * commit under load), then fail closed with the pending conflict.
   */
  private async pollPendingInvite(
    db: Db,
    orgId: string,
    email: string,
    lockId: string,
  ): Promise<InviteRow | null> {
    const invites = orgCollection<InviteMongoDoc>(db, 'org_invites');
    const locks = new PlatformCollection<InviteCreateLockMongoDoc>(
      db.collection<InviteCreateLockMongoDoc>('org_invite_create_locks'),
    );
    // 10s budget. Stop early when the lock is gone: the winner deletes it
    // in a `finally` after its transaction, so a missing lock means the
    // winner finished — the row is either committed (returned below) or the
    // winner failed a guard (caller retries and takes the normal path).
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const doc = await invites.findOne(orgId, {
        email,
        accepted_at: null,
        revoked_at: null,
        expires_at: { $gt: nowIso() },
      });
      if (doc) {
        return toInviteRow(doc);
      }
      const lock = await locks.findOne({ _id: lockId });
      if (!lock) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async listInvites(orgId: string): Promise<InviteRow[]> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.invites
        .find(orgId, {}, t.session)
        .sort({ created_at: -1 })
        .limit(500)
        .toArray();
      return rows.map(toInviteRow);
    });
  }

  async getInvite(orgId: string, inviteId: string): Promise<InviteRow | null> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.invites.findOne(
        orgId,
        { id: binUuid(inviteId, 'inviteId') },
        t.session,
      );
      return row ? toInviteRow(row) : null;
    });
  }

  async revokeInvite(orgId: string, inviteId: string): Promise<void> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = nowIso();
      await t.invites.updateOne(
        orgId,
        { id: binUuid(inviteId, 'inviteId') },
        { $set: { revoked_at: now, updated_at: now } },
        t.session,
      );
    });
  }

  async rotateToken(input: {
    orgId: string;
    inviteId: string;
    expectedTokenHash: string;
    tokenHash: string;
    expiresAt: string;
    resendCount: number;
  }): Promise<boolean> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // Rotation guard: the update only lands on the row whose hash we read —
      // a concurrent redeem/resend loses the race visibly instead of silently.
      const res = await t.invites.updateOne(
        input.orgId,
        { id: binUuid(input.inviteId, 'inviteId'), token_hash: input.expectedTokenHash },
        {
          $set: {
            token_hash: input.tokenHash,
            attempts: 0,
            expires_at: input.expiresAt,
            resend_count: input.resendCount,
            updated_at: nowIso(),
          },
        },
        t.session,
      );
      return res.matchedCount === 1;
    });
  }

  async extendExpiry(orgId: string, inviteId: string, expiresAt: string): Promise<void> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.invites.updateOne(
        orgId,
        { id: binUuid(inviteId, 'inviteId') },
        { $set: { expires_at: expiresAt, updated_at: nowIso() } },
        t.session,
      );
    });
  }

  async getInviteById(inviteId: string): Promise<InviteRow | null> {
    // Justification (unscoped PlatformCollection read): redemption/preview
    // happen BEFORE the caller is a member — RLS on org_id cannot admit the
    // row yet on the pg lane (withBypass). Without RLS there is no bypass
    // flag to set, so a direct unscoped read on the root handle is the
    // equivalent. Filtering is by the invite's unguessable id (+ hash
    // comparison by the service). Single read: no transaction needed.
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    const invites = new PlatformCollection<InviteMongoDoc>(db.collection<InviteMongoDoc>('org_invites'));
    const row = await invites.findOne({ id: binUuid(inviteId, 'inviteId') });
    return row ? toInviteRow(row) : null;
  }

  async claimInvite(orgId: string, inviteId: string): Promise<boolean> {
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // Single-use guard: the claim only lands on a still-usable row
      // (unclaimed, unrevoked, unexpired). Tenant-scoped (the pg lane uses
      // withOrg, NOT root: org_invites has RLS FORCED, so an unscoped
      // update would match 0 rows). The expiry predicate is
      // defense-in-depth: the service already rejects expired invites
      // before claiming, but the repository must not honor an invite the
      // domain deems unusable.
      const res = await t.invites.updateOne(
        orgId,
        {
          id: binUuid(inviteId, 'inviteId'),
          accepted_at: null,
          revoked_at: null,
          expires_at: { $gt: nowIso() },
        },
        { $set: { accepted_at: nowIso() } },
        t.session,
      );
      return res.matchedCount === 1;
    });
  }

  async registerAttempt(inviteId: string, attempts: number): Promise<void> {
    // Unscoped by-id write (the mongo twin of the pg lane's db.root): the
    // brute-force counter must land even when no tenant context admits the
    // row — failed redemption attempts arrive precisely when the caller is
    // not a member. Single write: no transaction needed.
    const db = this.mongo.root;
    await ensureInviteIndexes(db);
    const invites = new PlatformCollection<InviteMongoDoc>(db.collection<InviteMongoDoc>('org_invites'));
    await invites.updateOne(
      { id: binUuid(inviteId, 'inviteId') },
      { $set: { attempts: attempts + 1 } },
    );
  }
}
