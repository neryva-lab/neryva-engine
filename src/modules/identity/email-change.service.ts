import { eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { accounts } from './schema';
import { AccountsService, normalizeEmail } from './accounts.service';
import { CredentialsService } from './credentials.service';
import { EmailCodeService } from './email-code.service';
import { MfaService } from './mfa.service';

/**
 * Email change (H-7): the address IS the identity, so the bar is re-auth
 * on the way in and proof of the NEW mailbox on the way out:
 *
 *  - request: current password (or a live second factor for passwordless
 *    MFA accounts) + uniqueness check → an 8-digit code goes to the NEW
 *    address via the login-code infrastructure (hashed at rest,
 *    single-use, attempt-capped).
 *  - confirm: code verified + consumed atomically, uniqueness re-checked
 *    inside the swap (citext unique index is the final arbiter), the new
 *    address lands verified (the code just proved mailbox control),
 *    every session/token dies, and the OLD address is notified.
 *
 * Known trade-off (documented): codes are keyed per account, so a pending
 * email-change code voids any outstanding login code for that account.
 */
@Injectable()
export class EmailChangeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly email: EmailService,
    private readonly accountsService: AccountsService,
    private readonly credentials: CredentialsService,
    private readonly emailCodes: EmailCodeService,
    private readonly mfa: MfaService,
  ) {}

  async request(input: { accountId: string; newEmail: string; password?: string; factor?: string; requestIp: string | null }): Promise<{ ok: true }> {
    const account = await this.accountsService.findById(input.accountId);
    if (!account || account.status !== 'active') {
      throw ApiError.notFound('account');
    }
    // Re-auth mirrors account deletion: password when one exists, always
    // the second factor when TOTP is enrolled.
    let confirmed = false;
    if (account.passwordHash) {
      if (!input.password || !(await this.credentials.verifyPassword(account.passwordHash, input.password))) {
        await this.audit.add({
          action: 'email.change_failed',
          resourceType: 'account',
          resourceId: input.accountId,
          actorType: 'account',
          actorId: input.accountId,
          details: { reason: 'bad_password' },
        });
        throw ApiError.unauthenticated('Current password is incorrect');
      }
      confirmed = true;
    }
    if (await this.mfa.requiresSecondFactor(input.accountId)) {
      if (!input.factor || !(await this.mfa.verifyLoginFactor(input.accountId, input.factor))) {
        throw ApiError.unauthenticated('A live TOTP or recovery code is required');
      }
      confirmed = true;
    }
    if (!confirmed) {
      throw ApiError.forbidden('set a password or enable two-factor authentication before changing your email');
    }

    const newEmail = normalizeEmail(input.newEmail);
    if (newEmail === account.email.toLowerCase()) {
      throw ApiError.validation({ new_email: 'this is already your email address' });
    }
    // Enumeration note: a taken address is an explicit conflict — the
    // requester just authenticated, so enumeration resistance does not
    // apply here (same posture as org invites).
    if (await this.accountsService.findByEmail(newEmail)) {
      throw ApiError.conflict('that email address is already in use');
    }
    const issue = await this.emailCodes.issue(account.id, input.requestIp);
    if (!issue.ok) {
      throw ApiError.rateLimited(60);
    }
    await this.email.sendTemplate({
      template: 'identity.email-change',
      to: newEmail,
      vars: { code: issue.code, ttl_minutes: String(Math.round(env.IDENTITY_EMAIL_CODE_TTL_SECONDS / 60)) },
      metadata: { accountId: account.id },
    });
    await this.audit.add({
      action: 'email.change_requested',
      resourceType: 'account',
      resourceId: account.id,
      actorType: 'account',
      actorId: account.id,
      details: { to_domain: newEmail.split('@')[1] ?? '' },
    });
    return { ok: true };
  }

  async confirm(input: { accountId: string; newEmail: string; code: string }): Promise<{ ok: true }> {
    const account = await this.accountsService.findById(input.accountId);
    if (!account) {
      throw ApiError.notFound('account');
    }
    const newEmail = normalizeEmail(input.newEmail);
    const verified = await this.emailCodes.verify(account.id, input.code);
    if (!verified.ok) {
      await this.emailCodes.registerFailedAttempt(account.id);
      await this.audit.add({
        action: 'email.change_failed',
        resourceType: 'account',
        resourceId: account.id,
        actorType: 'account',
        actorId: account.id,
        details: { reason: `code_${verified.reason}` },
      });
      throw ApiError.unauthenticated('Invalid or expired code');
    }
    if (!(await this.emailCodes.consume(account.id, input.code))) {
      throw ApiError.unauthenticated('Invalid or expired code');
    }

    // The swap: atomic on the citext unique index even under a race — the
    // loser surfaces as a conflict, never as a duplicate identity.
    try {
      await this.db.root.transaction(async (tx) => {
        const updated = await tx
          .update(accounts)
          .set({ email: newEmail, emailVerifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(accounts.id, account.id))
          .returning({ id: accounts.id });
        if (!updated[0]) {
          throw new Error('email swap produced no row');
        }
      });
    } catch {
      throw ApiError.conflict('that email address is already in use');
    }

    // Tokens/sessions minted against the old address die with the change.
    await this.accountsService.revokeAllSessions(account.id);
    await this.audit.add({
      action: 'email.changed',
      resourceType: 'account',
      resourceId: account.id,
      actorType: 'account',
      actorId: account.id,
      details: { to_domain: newEmail.split('@')[1] ?? '' },
    });
    await this.events.emit(EngineEvents.AccountEmailChanged, { accountId: account.id, from: account.email, to: newEmail });
    await this.email.sendTemplate({ template: 'identity.email-changed', to: account.email, vars: { new_email: newEmail }, metadata: { accountId: account.id } }).catch(() => undefined);
    return { ok: true };
  }
}
