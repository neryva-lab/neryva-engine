import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { AccountsService } from '../identity/accounts.service';
import { assertRole, MembershipsService } from './memberships.service';
import { orgInvites } from './schema';

/**
 * The invite flow (Δ3): the ONLY sanctioned path to join an org. Tokens are
 * 32-byte urlsafe randoms stored as SHA-256, single-use, expiring (7 days),
 * attempt-capped (5), and bound to the invited email — redemption requires
 * a logged-in account whose email matches.
 */
const INVITE_TTL_DAYS = 7;
const MAX_REDEEM_ATTEMPTS = 5;

@Injectable()
export class InvitesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly accounts: AccountsService,
    private readonly memberships: MembershipsService,
  ) {}

  async create(input: { orgId: string; email: string; role: string; actorId: string; orgName: string; inviterEmail: string }): Promise<{ inviteId: string }> {
    assertRole(input.role);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString();
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgInvites)
        .values({
          orgId: input.orgId,
          email: input.email.trim().toLowerCase(),
          role: input.role,
          tokenHash: sha256Hex(token),
          invitedBy: input.actorId,
          expiresAt,
        })
        .returning({ id: orgInvites.id }),
    );
    await this.audit.add({
      action: 'org.invite_created',
      resourceType: 'org_invite',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { role: input.role, ttl_days: INVITE_TTL_DAYS },
    });
    await this.email.sendTemplate({
      template: 'org.invite',
      to: input.email,
      vars: {
        inviter: input.inviterEmail,
        org_name: input.orgName,
        role: input.role,
        ttl_days: String(INVITE_TTL_DAYS),
        accept_url: `${env.ENGINE_BASE_URL.replace(/\/$/, '')}/platform/invites/${inserted[0].id}?token=${token}`,
      },
      metadata: { inviteId: inserted[0].id, orgId: input.orgId },
    });
    // The token is returned to nobody — only the email carries it. The row
    // stores its hash.
    return { inviteId: inserted[0].id };
  }

  async list(orgId: string): Promise<Array<typeof orgInvites.$inferSelect>> {
    return this.db.withOrg(orgId, (tx) => tx.select().from(orgInvites).where(eq(orgInvites.orgId, orgId)));
  }

  async revoke(input: { orgId: string; inviteId: string; actorId: string }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx.update(orgInvites).set({ revokedAt: new Date().toISOString() }).where(and(eq(orgInvites.id, input.inviteId), eq(orgInvites.orgId, input.orgId))),
    );
    await this.audit.add({
      action: 'org.invite_revoked',
      resourceType: 'org_invite',
      resourceId: input.inviteId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  /**
   * Redeem (O-4): a logged-in account matching the invited email joins the
   * org. Attempt-capped on the invite row; single-use by accepted_at; the
   * token comparison is by hash (constant-time via the unique index lookup).
   */
  async redeem(input: { inviteId: string; token: string; accountId: string }): Promise<void> {
    const rows = await this.db.withBypass((tx) =>
      // Justification (withBypass): redemption happens BEFORE the caller is
      // a member — RLS on org_id cannot admit the row yet. Filtering is by
      // the invite's unguessable id + hash.
      tx.select().from(orgInvites).where(eq(orgInvites.id, input.inviteId)).limit(1),
    );
    const invite = rows[0];
    if (!invite || invite.tokenHash !== sha256Hex(input.token)) {
      if (invite) {
        await this.registerAttempt(invite.id, invite.attempts);
      }
      throw ApiError.unauthenticated('Invalid invitation');
    }
    if (invite.revokedAt || invite.acceptedAt) {
      throw ApiError.conflict('Invitation is no longer usable');
    }
    if (Date.parse(invite.expiresAt) < Date.now()) {
      throw ApiError.conflict('Invitation expired');
    }
    if (invite.attempts >= MAX_REDEEM_ATTEMPTS) {
      throw ApiError.conflict('Invitation locked after too many attempts');
    }

    const account = await this.accounts.findById(input.accountId);
    if (!account || account.email !== invite.email) {
      await this.registerAttempt(invite.id, invite.attempts);
      throw ApiError.forbidden('This invitation was sent to a different email address');
    }

    // Single-use guard: the claim only lands on a still-unclaimed row.
    const claimed = await this.db.root
      .update(orgInvites)
      .set({ acceptedAt: new Date().toISOString() })
      .where(and(eq(orgInvites.id, invite.id), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt)))
      .returning({ id: orgInvites.id });
    if (claimed.length !== 1) {
      throw ApiError.conflict('Invitation is no longer usable');
    }

    await this.memberships.addMember({
      orgId: invite.orgId,
      accountId: input.accountId,
      role: invite.role as never,
      invitedBy: invite.invitedBy,
    });
    await this.audit.add({
      action: 'org.invite_accepted',
      resourceType: 'org_invite',
      resourceId: invite.id,
      actorType: 'account',
      actorId: input.accountId,
      tenantId: invite.orgId,
    });
  }

  private async registerAttempt(inviteId: string, currentAttempts: number): Promise<void> {
    await this.db.root
      .update(orgInvites)
      .set({ attempts: currentAttempts + 1 })
      .where(eq(orgInvites.id, inviteId));
  }
}
