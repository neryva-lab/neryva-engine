import { randomBytes } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { AccountsService } from '../identity/accounts.service';
import { normalizeEmail } from '../identity/accounts.service';
import { assertInvitableRole, MembershipsService } from './memberships.service';
import { getOrgName } from './org-info';
import { INVITE_REPOSITORY, ORG_INFO_REPOSITORY } from './repositories/repository-tokens';
import type { IInviteRepository, InviteRow } from './repositories/invite.repository';
import type { IOrgInfoRepository } from './repositories/org-info.repository';

/** Computed lifecycle state for the invite list (never stored — cannot drift). */
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InviteView {
  id: string;
  email: string;
  role: string;
  status: InviteStatus;
  invitedBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  resendCount: number;
  attempts: number;
}

const MAX_REDEEM_ATTEMPTS = 5;
const MAX_RESENDS = 5;

/**
 * The invite flow (Δ3): the ONLY sanctioned path to join an org. Tokens are
 * 32-byte urlsafe randoms stored as SHA-256, single-use, expiring
 * (ORG_INVITE_TTL_DAYS), attempt-capped (5), and bound to the invited email
 * — redemption requires a logged-in account whose email matches.
 *
 * Dense pass (eng-0009): the full WorkOS/Cloudsmith lifecycle — create
 * (duplicate/member/cap guards), resend (token ROTATION: the old hash dies,
 * attempts reset), extend (expiry push without token churn), and computed
 * status on every row. Ownership is never granted by invitation — only via
 * step-up-gated transfer.
 *
 * Persistence lives behind `IInviteRepository` (P3) — this service owns
 * validation, token minting/hashing, the invite state guards, audit,
 * events, and emails, and never touches the database directly.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(INVITE_REPOSITORY) private readonly invites: IInviteRepository,
    @Inject(ORG_INFO_REPOSITORY) private readonly orgInfo: IOrgInfoRepository,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly email: EmailService,
    private readonly accounts: AccountsService,
    private readonly memberships: MembershipsService,
  ) {}

  async create(input: { orgId: string; email: string; role: string; delivery: string; actorId: string; actorEmail?: string | null }): Promise<{ inviteId: string; email: string; accept_url?: string; expires_at?: string }> {
    assertInvitableRole(input.role);
    const delivery = normalizeInviteDelivery(input.delivery);
    const email = normalizeEmail(input.email);

    // The token is minted here (the repository never sees raw tokens — it
    // receives the hash). On an idempotent replay the token is discarded:
    // the stored row holds only its hash, so no accept_url can be rebuilt.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env.ORG_INVITE_TTL_DAYS * 86_400_000).toISOString();
    const { invite, created } = await this.invites.createInvite({
      orgId: input.orgId,
      email,
      role: input.role,
      invitedBy: input.actorId,
      tokenHash: sha256Hex(token),
      expiresAt,
    });
    if (created) {
      await this.audit.add({
        action: 'org.invite_created',
        resourceType: 'org_invite',
        resourceId: invite.id,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        details: { role: input.role, ttl_days: env.ORG_INVITE_TTL_DAYS },
      });
      await this.events.emit(EngineEvents.OrgInviteCreated, { orgId: input.orgId, inviteId: invite.id, email, role: input.role });
    }
    if (delivery === 'manual') {
      // Manual delivery: the Engine sends nothing. The raw accept URL is
      // returned ONCE here and never again (hash-only storage) — it is
      // never logged, never audited, and never present in list/detail.
      // On an idempotent replay there is no token to return, so accept_url
      // is absent on that path by construction.
      return created
        ? { inviteId: invite.id, email, accept_url: this.inviteUrl(invite.id, token), expires_at: expiresAt }
        : { inviteId: invite.id, email, expires_at: invite.expiresAt };
    }
    if (created) {
      await this.sendInviteEmail({ inviteId: invite.id, token, orgId: input.orgId, email, role: input.role, actorId: input.actorId, actorEmail: input.actorEmail });
    }
    // The token is returned to nobody — only the email carries it. The row
    // stores its hash. (On an idempotent replay no email is re-sent: there
    // is no token to send.)
    return { inviteId: invite.id, email };
  }

  async list(orgId: string): Promise<InviteView[]> {
    const rows = await this.invites.listInvites(orgId);
    return rows.map(toView);
  }

  /**
   * Detail read (team-loop ledger T1): single pending-history row by id+org.
   * Hash-free by construction — the row stores `token_hash` only, and `toView`
   * never emits it, so List / Detail / Extend uniformly never return URL/token.
   */
  async detail(orgId: string, inviteId: string): Promise<InviteView> {
    const invite = await this.invites.getInvite(orgId, inviteId);
    if (!invite) {
      throw ApiError.notFound('invitation');
    }
    return toView(invite);
  }

  async revoke(input: { orgId: string; inviteId: string; actorId: string }): Promise<void> {
    const invite = await this.invites.getInvite(input.orgId, input.inviteId);
    if (!invite) {
      throw ApiError.notFound('invitation');
    }
    if (invite.revokedAt || invite.acceptedAt) {
      throw ApiError.conflict('invitation is no longer usable');
    }
    await this.invites.revokeInvite(input.orgId, input.inviteId);
    await this.audit.add({
      action: 'org.invite_revoked',
      resourceType: 'org_invite',
      resourceId: input.inviteId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { email: invite.email },
    });
    await this.events.emit(EngineEvents.OrgInviteRevoked, { orgId: input.orgId, inviteId: input.inviteId, email: invite.email });
  }

  /**
   * Resend: rotate the token (the previous hash dies immediately — a leaked
   * email link cannot survive a resend), reset attempts, restart the TTL
   * clock. Capped per invite so a stuck mailbox cannot loop forever.
   */
  async resend(input: { orgId: string; inviteId: string; delivery: string; actorId: string; actorEmail?: string | null }): Promise<{ expires_at: string; accept_url?: string }> {
    const delivery = normalizeInviteDelivery(input.delivery);
    const invite = await this.invites.getInvite(input.orgId, input.inviteId);
    if (!invite) {
      throw ApiError.notFound('invitation');
    }
    if (invite.revokedAt || invite.acceptedAt) {
      throw ApiError.conflict('invitation is no longer usable');
    }
    if (invite.resendCount >= MAX_RESENDS) {
      throw ApiError.conflict(`invitation reached its resend cap (${MAX_RESENDS}) — revoke and create a new one`);
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + env.ORG_INVITE_TTL_DAYS * 86_400_000).toISOString();
    const rotated = await this.invites.rotateToken({
      orgId: input.orgId,
      inviteId: invite.id,
      expectedTokenHash: invite.tokenHash,
      tokenHash: sha256Hex(token),
      expiresAt,
      resendCount: invite.resendCount + 1,
    });
    if (!rotated) {
      throw ApiError.conflict('invitation changed concurrently — reload and retry');
    }

    await this.audit.add({
      action: 'org.invite_resent',
      resourceType: 'org_invite',
      resourceId: invite.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { email: invite.email, resend_count: invite.resendCount + 1, delivery },
    });
    if (delivery === 'manual') {
      return { expires_at: expiresAt, accept_url: this.inviteUrl(invite.id, token) };
    }
    await this.sendInviteEmail({ inviteId: invite.id, token, orgId: input.orgId, email: invite.email, role: invite.role, actorId: input.actorId, actorEmail: input.actorEmail });
    return { expires_at: expiresAt };
  }

  /** Extend the accept window without rotating the token (the emailed link stays valid). */
  async extend(input: { orgId: string; inviteId: string; days: number; actorId: string }): Promise<{ expires_at: string }> {
    const invite = await this.invites.getInvite(input.orgId, input.inviteId);
    if (!invite) {
      throw ApiError.notFound('invitation');
    }
    if (invite.revokedAt || invite.acceptedAt) {
      throw ApiError.conflict('invitation is no longer usable');
    }
    const days = Math.min(Math.max(Math.floor(input.days), 1), 30);
    const base = Math.max(Date.parse(invite.expiresAt), Date.now());
    const expiresAt = new Date(base + days * 86_400_000).toISOString();
    await this.invites.extendExpiry(input.orgId, invite.id, expiresAt);
    await this.audit.add({
      action: 'org.invite_extended',
      resourceType: 'org_invite',
      resourceId: invite.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { email: invite.email, days, expires_at: expiresAt },
    });
    return { expires_at: expiresAt };
  }

  /**
   * Redeem (O-4): a logged-in account matching the invited email joins the
   * org. Attempt-capped on the invite row; single-use by accepted_at; the
   * token comparison is by hash (constant-time via the unique index lookup).
   */
  async redeem(input: { inviteId: string; token: string; accountId: string }): Promise<{ orgId: string; role: string }> {
    const invite = await this.invites.getInviteById(input.inviteId);
    if (!invite || invite.tokenHash !== sha256Hex(input.token)) {
      if (invite) {
        await this.invites.registerAttempt(invite.id, invite.attempts);
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
      await this.invites.registerAttempt(invite.id, invite.attempts);
      throw ApiError.forbidden('This invitation was sent to a different email address');
    }

    // Membership FIRST, claim second (AUTH-4.1): addMember may legitimately
    // refuse (seat_limit_reached / member cap) — the invite must stay usable
    // so the org can buy seats and retry, not burn. addMember is an upsert on
    // (account, org), so a concurrent double-redeem is idempotent; the
    // single-use claim below still guarantees exactly one acceptance path.
    await this.memberships.addMember({
      orgId: invite.orgId,
      accountId: input.accountId,
      role: invite.role as never,
      invitedBy: invite.invitedBy,
    });

    // Single-use guard: the claim only lands on a still-unclaimed row.
    const claimed = await this.invites.claimInvite(invite.orgId, invite.id);
    if (!claimed) {
      throw ApiError.conflict('Invitation is no longer usable');
    }

    await this.audit.add({
      action: 'org.invite_accepted',
      resourceType: 'org_invite',
      resourceId: invite.id,
      actorType: 'account',
      actorId: input.accountId,
      tenantId: invite.orgId,
      details: { email: invite.email, role: invite.role },
    });
    await this.events.emit(EngineEvents.OrgInviteAccepted, { orgId: invite.orgId, inviteId: invite.id, accountId: input.accountId, role: invite.role });
    return { orgId: invite.orgId, role: invite.role };
  }

  /**
   * Public preview (side-effect free): what the invitee would accept. The
   * ONLY token-consuming read that changes nothing — no attempt registration
   * (link scanners must not burn invites), no audit row (no token-adjacent
   * records), uniform generic failure for every non-usable state so no
   * oracle distinguishes missing/revoked/expired/accepted/locked.
   */
  async preview(input: { inviteId: string; token: string }): Promise<{ org_name: string; role: string; expires_at: string; invited_by: string; email_hint: string }> {
    const t = (input.token ?? '').trim();
    if (!input.inviteId || !t || t.length > 256) {
      throw ApiError.notFound('invitation');
    }
    const invite = await this.invites.getInviteById(input.inviteId);
    if (!invite || invite.tokenHash !== sha256Hex(t)) {
      throw ApiError.notFound('invitation');
    }
    if (invite.revokedAt || invite.acceptedAt || Date.parse(invite.expiresAt) < Date.now() || invite.attempts >= MAX_REDEEM_ATTEMPTS) {
      throw ApiError.notFound('invitation');
    }
    const inviter = invite.invitedBy ? await this.accounts.findById(invite.invitedBy).catch(() => null) : null;
    return {
      org_name: await getOrgName(this.orgInfo, invite.orgId),
      role: invite.role,
      expires_at: invite.expiresAt,
      invited_by: inviter?.displayName?.trim() ? String(inviter.displayName) : 'a member of your team',
      email_hint: maskInviteEmail(invite.email),
    };
  }

  /** Invite-accept URL for the console route (frontend: /platform/invites/:id?token=). */
  inviteUrl(inviteId: string, token: string): string {
    // UI links must resolve at the console-facing base, not the API origin:
    // ENGINE_UI_BASE_URL is the documented home for emailed UI links (env.ts)
    // while ENGINE_BASE_URL stays the fallback, so edge-unified deployments
    // (single public base) behave exactly as before.
    const base = (env.ENGINE_UI_BASE_URL || env.ENGINE_BASE_URL).replace(/\/$/, '');
    return `${base}/platform/invites/${inviteId}?token=${token}`;
  }

  private async sendInviteEmail(input: { inviteId: string; token: string; orgId: string; email: string; role: string; actorId: string; actorEmail?: string | null }): Promise<void> {
    const orgName = await getOrgName(this.orgInfo, input.orgId);
    await this.email.sendTemplate({
      template: 'org.invite',
      to: input.email,
      vars: {
        inviter: input.actorEmail ?? 'a member of your team',
        org_name: orgName,
        role: input.role,
        ttl_days: String(env.ORG_INVITE_TTL_DAYS),
        accept_url: this.inviteUrl(input.inviteId, input.token),
      },
      metadata: { inviteId: input.inviteId, orgId: input.orgId },
    });
  }
}

function toView(row: InviteRow): InviteView {
  const status: InviteStatus =
    row.acceptedAt ? 'accepted' : row.revokedAt ? 'revoked' : Date.parse(row.expiresAt) < Date.now() ? 'expired' : 'pending';
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt ?? null,
    revokedAt: row.revokedAt ?? null,
    resendCount: row.resendCount,
    attempts: row.attempts,
  };
}

/** Delivery channels for an invite. Email = Engine sends; manual = admin forwards. */
export type InviteDelivery = 'email' | 'manual';

/**
 * Fail-closed delivery parsing (DTO whitelists first; the service is the
 * trust boundary). Pure — unit-tested.
 */
export function normalizeInviteDelivery(raw: unknown): InviteDelivery {
  if (raw === 'email' || raw === 'manual') {
    return raw;
  }
  throw ApiError.validation({ delivery: "must be 'email' or 'manual'" });
}

/**
 * Masked email hint for the public preview: first local-part character +
 * full domain (e.g. j***@acme.com). Enough for the invitee to recognize
 * which mailbox to use, useless for harvesting. Pure — unit-tested.
 */
export function maskInviteEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  const domain = email.slice(at + 1);
  if (!domain) {
    return '***';
  }
  return `${email.slice(0, 1)}***@${domain}`;
}
