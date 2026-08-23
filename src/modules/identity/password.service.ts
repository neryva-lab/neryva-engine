import { and, desc, eq, isNull } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { EmailService } from '../corporate/email/email.service';
import { env } from '../../common/config/env';
import { accounts, oauthSessions } from './schema';
import { AccountsService, normalizeEmail } from './accounts.service';
import { CredentialsService } from './credentials.service';
import { AccountActionsService } from './account-actions.service';

/**
 * Password lifecycle + session management surface:
 *
 *  - reset request/confirm: single-use emailed token → argon2id rehash →
 *    GLOBAL session revocation (a reset must kill every stolen session)
 *  - set/change (authenticated): change requires the current password and
 *    revokes all OTHER sessions; set is for passwordless accounts and
 *    requires a verified email
 *  - session list / revoke-one / revoke-all: the device-management surface
 *    the oauth_sessions table was built for
 *
 * Password rules live in CredentialsService (12–512 chars). Every
 * credential event is audited; notifications email the account owner.
 */
@Injectable()
export class PasswordService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly email: EmailService,
    private readonly accountsService: AccountsService,
    private readonly credentials: CredentialsService,
    private readonly actions: AccountActionsService,
  ) {}

  // ── reset flow ─────────────────────────────────────────────────────────────

  /** Always behaves identically whether or not the account exists (enumeration-safe). */
  async requestReset(rawEmail: string, requestIp: string | null): Promise<void> {
    let account: typeof accounts.$inferSelect | null = null;
    try {
      account = await this.accountsService.findByEmail(normalizeEmail(rawEmail));
    } catch {
      account = null; // malformed email — same outward behavior
    }
    if (!account || account.status !== 'active') {
      return; // uniform silence
    }
    const issued = await this.actions.issue(account.id, 'password_reset', requestIp);
    if (!issued.ok) {
      return; // cooldown — the mail flood guard did its job
    }
    const url = `${resetUiBase()}/reset-password?token=${encodeURIComponent(issued.token)}`;
    await this.email
      .sendTemplate({
        template: 'identity.password-reset',
        to: account.email,
        vars: { reset_url: url, ttl_minutes: '30' },
        metadata: { accountId: account.id },
      })
      .catch(() => undefined); // delivery failure must not leak account existence
    await this.audit.add({
      action: 'password.reset_requested',
      resourceType: 'account',
      resourceId: account.id,
      actorType: 'system',
      details: {},
    });
  }

  async confirmReset(token: string, newPassword: string): Promise<void> {
    const peek = await this.actions.peek(token, 'password_reset');
    if (!peek.ok) {
      await this.actions.registerFailedAttempt(token, 'password_reset');
      throw ApiError.unauthenticated('Invalid or expired reset link');
    }
    const consumed = await this.actions.consume(token, 'password_reset');
    if (!consumed.ok) {
      throw ApiError.unauthenticated('Invalid or expired reset link');
    }
    const hash = await this.credentials.hashPassword(newPassword);
    await this.accountsService.updatePasswordHash(consumed.accountId, hash);
    await this.accountsService.revokeAllSessions(consumed.accountId); // kill every stolen session
    await this.recordRevocation(consumed.accountId);
    await this.audit.add({
      action: 'password.reset_completed',
      resourceType: 'account',
      resourceId: consumed.accountId,
      actorType: 'account',
      actorId: consumed.accountId,
      details: {},
    });
    const account = await this.accountsService.findById(consumed.accountId);
    if (account) {
      await this.email.sendTemplate({ template: 'identity.password-changed', to: account.email, vars: {}, metadata: { accountId: account.id } }).catch(() => undefined);
    }
  }

  // ── authenticated password set/change ──────────────────────────────────────

  /** Change an existing password (requires the current one). */
  async changePassword(accountId: string, currentPassword: string, newPassword: string): Promise<void> {
    const account = await this.accountsService.findById(accountId);
    if (!account) {
      throw ApiError.notFound('account');
    }
    if (!account.passwordHash) {
      throw ApiError.conflict('no password set — use the set-password endpoint');
    }
    if (!(await this.credentials.verifyPassword(account.passwordHash, currentPassword))) {
      await this.audit.add({
        action: 'password.change_failed',
        resourceType: 'account',
        resourceId: accountId,
        actorType: 'account',
        actorId: accountId,
        details: { reason: 'bad_current' },
      });
      throw ApiError.unauthenticated('Current password is incorrect');
    }
    const hash = await this.credentials.hashPassword(newPassword);
    await this.accountsService.updatePasswordHash(accountId, hash);
    await this.accountsService.revokeAllSessions(accountId);
    await this.recordRevocation(accountId);
    await this.audit.add({
      action: 'password.changed',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
    await this.email.sendTemplate({ template: 'identity.password-changed', to: account.email, vars: {}, metadata: { accountId } }).catch(() => undefined);
  }

  /** First password for a passwordless account — requires a verified mailbox. */
  async setPassword(accountId: string, newPassword: string): Promise<void> {
    const account = await this.accountsService.findById(accountId);
    if (!account) {
      throw ApiError.notFound('account');
    }
    if (account.passwordHash) {
      throw ApiError.conflict('password already set — use the change-password endpoint');
    }
    // The one-way binding rule (doc-06 Δ1, benchmark pattern #5): an
    // account CREATED via federation never grows a password — the
    // federated credential is its only password-class factor by design.
    if (account.createdVia.startsWith('social:')) {
      throw ApiError.forbidden('accounts created with a federated sign-in cannot add a password (one-way binding)');
    }
    if (!account.emailVerifiedAt) {
      throw ApiError.forbidden('verify your email before setting a password');
    }
    const hash = await this.credentials.hashPassword(newPassword);
    await this.accountsService.updatePasswordHash(accountId, hash);
    await this.audit.add({
      action: 'password.set',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
  }

  // ── email verification flow ────────────────────────────────────────────────

  async requestEmailVerification(accountId: string, requestIp: string | null): Promise<void> {
    const account = await this.accountsService.findById(accountId);
    if (!account) {
      throw ApiError.notFound('account');
    }
    if (account.emailVerifiedAt) {
      return; // already verified — idempotent
    }
    const issued = await this.actions.issue(account.id, 'email_verify', requestIp);
    if (!issued.ok) {
      return; // cooldown
    }
    const url = `${resetUiBase()}/verify-email?token=${encodeURIComponent(issued.token)}`;
    await this.email.sendTemplate({
      template: 'identity.email-verification',
      to: account.email,
      vars: { verify_url: url, ttl_minutes: '30' },
      metadata: { accountId: account.id },
    });
    await this.audit.add({
      action: 'email.verification_requested',
      resourceType: 'account',
      resourceId: account.id,
      actorType: 'account',
      actorId: account.id,
      details: {},
    });
  }

  async confirmEmailVerification(token: string): Promise<void> {
    const peek = await this.actions.peek(token, 'email_verify');
    if (!peek.ok) {
      await this.actions.registerFailedAttempt(token, 'email_verify');
      throw ApiError.unauthenticated('Invalid or expired verification link');
    }
    const consumed = await this.actions.consume(token, 'email_verify');
    if (!consumed.ok) {
      throw ApiError.unauthenticated('Invalid or expired verification link');
    }
    await this.accountsService.markEmailVerified(consumed.accountId);
    await this.audit.add({
      action: 'email.verified',
      resourceType: 'account',
      resourceId: consumed.accountId,
      actorType: 'account',
      actorId: consumed.accountId,
      details: {},
    });
  }

  // ── session management ─────────────────────────────────────────────────────

  async listSessions(accountId: string): Promise<
    Array<{ sid: string; client_id: string; device: Record<string, unknown>; created_at: string; last_seen_at: string | null; revoked: boolean }>
  > {
    const rows = await this.db.root
      .select()
      .from(oauthSessions)
      .where(eq(oauthSessions.accountId, accountId))
      .orderBy(desc(oauthSessions.createdAt))
      .limit(50);
    return rows.map((row) => ({
      sid: row.sid,
      client_id: row.clientId,
      device: (row.device ?? {}) as Record<string, unknown>,
      created_at: row.createdAt,
      last_seen_at: row.lastSeenAt,
      revoked: row.revokedAt !== null,
    }));
  }

  async revokeSession(accountId: string, sid: string): Promise<void> {
    const updated = await this.db.root
      .update(oauthSessions)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(oauthSessions.sid, sid), eq(oauthSessions.accountId, accountId), isNull(oauthSessions.revokedAt)))
      .returning({ sid: oauthSessions.sid });
    if (!updated[0]) {
      throw ApiError.notFound('session');
    }
    await this.events.emit(EngineEvents.SessionRevoked, { sid, accountId });
    await this.audit.add({
      action: 'session.revoked',
      resourceType: 'oauth_session',
      resourceId: sid,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
  }

  async revokeAllSessions(accountId: string): Promise<void> {
    await this.accountsService.revokeAllSessions(accountId);
    await this.recordRevocation(accountId);
    await this.audit.add({
      action: 'session.all_revoked',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: {},
    });
  }

  /** Durable revocation log for the satellite feed (single choke point). */
  private recordRevocation(accountId: string): void {
    void this.events.emit('identity.revocation', { kind: 'account_all', subjectId: accountId }).catch(() => undefined);
  }
}

/** The web app's auth page base — engine config, so the URLs live in one place. */
function resetUiBase(): string {
  return (env.ENGINE_UI_BASE_URL || env.ENGINE_BASE_URL).replace(/\/$/, '');
}
