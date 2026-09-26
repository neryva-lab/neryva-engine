import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { env } from '../../../common/config/env';
import { orgInvites, orgMemberships } from '../schema';
import type { IInviteRepository, InviteRow } from './invite.repository';

/**
 * PostgreSQL implementation of `IInviteRepository` (P3).
 *
 * Mechanical move of the `InvitesService` persistence units: every method
 * owns its transaction via `DbService.withOrg` (or `withBypass` / `root`
 * where the service did), runs all reads/writes inside it, and commits or
 * rolls back as one. No transaction handle leaks through this interface.
 * SQL and `ApiError` throws are preserved exactly as they were in the
 * service, with one deliberate change: `createInvite` now serializes
 * concurrent creates per (org, email) — see the method comment.
 *
 * What stays OUT (still the service's job): input validation, token
 * generation/hashing (the service passes `tokenHash`), invite state guards,
 * audit writes, event emission, invite emails, and tracing spans.
 */
export class PgInviteRepository implements IInviteRepository {
  constructor(private readonly db: DbService) {}

  async createInvite(input: {
    orgId: string;
    email: string;
    role: string;
    invitedBy: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<{ invite: InviteRow; created: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      // Guard: the email is already an active member.
      // Guard: a suspended member already holds a (deactivated) membership row
      // — inviting them would silently reactivate via the addMember upsert.
      // Reject with the reactivate path instead so the intent is explicit.
      // (Pre-lock reads: unchanged from the pre-migration service.)
      const priorMember = await tx
        .select({ id: orgMemberships.id, status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, sql`(select id from accounts where email = ${input.email})`)))
        .limit(1);
      if (priorMember[0]?.status === 'active') {
        throw ApiError.conflict('this email is already a member of the organization');
      }
      if (priorMember[0]?.status === 'suspended') {
        throw ApiError.conflict('this email belongs to a suspended member — reactivate them in the Members tab instead', {
          reason: 'member_suspended',
        });
      }

      // Concurrency patch (invite-creation race): two concurrent creates for
      // the same (org, email) used to both pass the guards and insert
      // duplicate pending invites. The transaction-scoped advisory lock
      // serializes the check→insert sequence per (org, email) key; it
      // releases automatically on commit/rollback, so a crashed worker can
      // never wedge the key.
      //
      // Idempotent replay: a usable invite observed for (org, email) —
      // whether a sequential duplicate or a concurrent loser's view of the
      // winner's committed row — is returned with `created: false`. No new
      // token is minted on this path, so the service cannot return an
      // accept_url for the replay.
      const lockKey = input.orgId + '|' + input.email.toLowerCase();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const existing = await pendingForTx(tx, input.orgId, input.email);
      if (existing) {
        return { invite: existing, created: false };
      }

      // Guard: pending-invite ceiling (typo/abuse posture).
      const pendingCount = await tx
        .select({ n: sql<number>`count(*)` })
        .from(orgInvites)
        .where(and(eq(orgInvites.orgId, input.orgId), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt), sql`${orgInvites.expiresAt} > now()`));
      if (Number(pendingCount[0]?.n ?? 0) >= env.ORG_MAX_PENDING_INVITES) {
        throw ApiError.conflict(`the organization is at its pending-invitation cap (${env.ORG_MAX_PENDING_INVITES})`);
      }

      const inserted = await tx
        .insert(orgInvites)
        .values({ orgId: input.orgId, email: input.email, role: input.role, tokenHash: input.tokenHash, invitedBy: input.invitedBy, expiresAt: input.expiresAt })
        .returning();
      return { invite: inserted[0], created: true };
    });
  }

  async listInvites(orgId: string): Promise<InviteRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgInvites).where(eq(orgInvites.orgId, orgId)).orderBy(desc(orgInvites.createdAt)).limit(500),
    );
  }

  async getInvite(orgId: string, inviteId: string): Promise<InviteRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgInvites).where(and(eq(orgInvites.id, inviteId), eq(orgInvites.orgId, orgId))).limit(1),
    );
    return rows[0] ?? null;
  }

  async revokeInvite(orgId: string, inviteId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withOrg(orgId, (tx) =>
      tx.update(orgInvites).set({ revokedAt: now, updatedAt: now }).where(eq(orgInvites.id, inviteId)),
    );
  }

  async rotateToken(input: {
    orgId: string;
    inviteId: string;
    expectedTokenHash: string;
    tokenHash: string;
    expiresAt: string;
    resendCount: number;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    // Rotation guard: the update only lands on the row whose hash we read —
    // a concurrent redeem/resend loses the race visibly instead of silently.
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgInvites)
        .set({ tokenHash: input.tokenHash, attempts: 0, expiresAt: input.expiresAt, resendCount: input.resendCount, updatedAt: now })
        .where(and(eq(orgInvites.id, input.inviteId), eq(orgInvites.tokenHash, input.expectedTokenHash)))
        .returning({ id: orgInvites.id }),
    );
    return updated.length === 1;
  }

  async extendExpiry(orgId: string, inviteId: string, expiresAt: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withOrg(orgId, (tx) =>
      tx.update(orgInvites).set({ expiresAt, updatedAt: now }).where(eq(orgInvites.id, inviteId)),
    );
  }

  async getInviteById(inviteId: string): Promise<InviteRow | null> {
    const rows = await this.db.withBypass((tx) =>
      // Justification (withBypass): redemption/preview happen BEFORE the
      // caller is a member — RLS on org_id cannot admit the row yet.
      // Filtering is by the invite's unguessable id + hash.
      tx.select().from(orgInvites).where(eq(orgInvites.id, inviteId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async claimInvite(orgId: string, inviteId: string): Promise<boolean> {
    // Single-use guard: the claim only lands on a still-usable row
    // (unclaimed, unrevoked, unexpired). Org-scoped via withOrg (NOT
    // this.db.root): org_invites has RLS FORCED, so an unscoped UPDATE
    // matches 0 rows and redeem would 409 even though the membership
    // already landed. The caller is a member of invite.orgId by this
    // point, so the tenant context admits the row. The expiry predicate
    // is defense-in-depth: the service already rejects expired invites
    // before claiming, but the repository must not honor an invite the
    // domain deems unusable.
    const claimed = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(orgInvites)
        .set({ acceptedAt: new Date().toISOString() })
        .where(
          and(
            eq(orgInvites.id, inviteId),
            isNull(orgInvites.acceptedAt),
            isNull(orgInvites.revokedAt),
            sql`${orgInvites.expiresAt} > now()`,
          ),
        )
        .returning({ id: orgInvites.id }),
    );
    return claimed.length === 1;
  }

  async registerAttempt(inviteId: string, attempts: number): Promise<void> {
    // db.root by invite id: the brute-force counter must land even when no
    // tenant context admits the row (failed redemption attempts arrive
    // precisely when the caller is not a member).
    await this.db.root
      .update(orgInvites)
      .set({ attempts: attempts + 1 })
      .where(eq(orgInvites.id, inviteId));
  }
}

/** One usable (not accepted, not revoked, not expired) invite for (org, email). */
async function pendingForTx(tx: NodePgDatabase, orgId: string, email: string): Promise<InviteRow | null> {
  const rows = await tx
    .select()
    .from(orgInvites)
    .where(and(eq(orgInvites.orgId, orgId), eq(orgInvites.email, email), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt), sql`${orgInvites.expiresAt} > now()`))
    .limit(1);
  return rows[0] ?? null;
}
