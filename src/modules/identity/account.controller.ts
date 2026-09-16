import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthLayer, CurrentPrincipal, Public } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { Idempotent } from '../../common/http/idempotency';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { AccountsService } from './accounts.service';
import { AccountDeletionService } from './account-deletion.service';
import { EmailChangeService } from './email-change.service';
import { OnboardingService, type OnboardingState } from './onboarding.service';

/**
 * The account lifecycle surface — the audit's blockers I-1/I-2 plus the
 * session-management and MFA surfaces that make them complete:
 *
 *  Public (rate-limited, enumeration-safe):
 *    POST /auth/password-reset/request|confirm
 *    POST /auth/email-verification/confirm
 *  Authenticated (L1):
 *    GET/PATCH /auth/me · GET /auth/me/sessions · POST …/revoke[-all]
 *    POST /auth/me/password[|/set] · POST /auth/email-verification/request
 *    POST /auth/mfa/{totp/enroll,totp/activate,totp/disable,proof,recovery/rotate}
 *    GET  /auth/mfa
 *    POST /auth/me/delete[/cancel] · GET /auth/me/deletion-status   (H-6)
 *    POST /auth/me/email-change/request|confirm                     (H-7)
 *    POST /auth/me/onboarding/welcome                               (F1-7)
 */
@Controller()
export class AccountController {
  constructor(
    private readonly password: PasswordService,
    private readonly mfa: MfaService,
    private readonly accounts: AccountsService,
    private readonly deletion: AccountDeletionService,
    private readonly emailChange: EmailChangeService,
    private readonly onboarding: OnboardingService,
  ) {}

  // ── public: password reset ────────────────────────────────────────────────

  @Public()
  @Post('auth/password-reset/request')
  @RateLimit({ name: 'pwreset-request', capacity: 3, refillPerSecond: 0.02, scope: 'ip' })
  async requestReset(@Body() body: { email?: string }, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    if (!body.email || typeof body.email !== 'string') {
      throw ApiError.validation({ email: 'required' });
    }
    await this.password.requestReset(body.email, req.ip ?? null);
    return { ok: true }; // uniform response — exists or not
  }

  @Public()
  @Post('auth/password-reset/confirm')
  @RateLimit({ name: 'pwreset-confirm', capacity: 10, refillPerSecond: 0.1, scope: 'ip' })
  async confirmReset(@Body() body: { token?: string; new_password?: string }): Promise<{ ok: true }> {
    if (!body.token || typeof body.new_password !== 'string') {
      throw ApiError.validation({ token: 'required', new_password: 'required' });
    }
    await this.password.confirmReset(body.token, body.new_password);
    return { ok: true };
  }

  // ── public: email verification ────────────────────────────────────────────

  @Public()
  @Post('auth/email-verification/confirm')
  @RateLimit({ name: 'emailverify-confirm', capacity: 10, refillPerSecond: 0.1, scope: 'ip' })
  async confirmVerification(@Body() body: { token?: string }): Promise<{ ok: true }> {
    if (!body.token) {
      throw ApiError.validation({ token: 'required' });
    }
    await this.password.confirmEmailVerification(body.token);
    return { ok: true };
  }

  // ── authenticated: profile ─────────────────────────────────────────────────

  @Get('auth/me')
  @AuthLayer('l1')
  async me(@CurrentPrincipal() principal: L1Principal) {
    const account = await this.accounts.findById(principal.id);
    if (!account) {
      throw ApiError.notFound('account');
    }
    return {
      account: {
        id: account.id,
        email: account.email,
        email_verified: account.emailVerifiedAt !== null,
        display_name: account.displayName,
        mfa_level: account.mfaLevel,
        status: account.status,
        last_login_at: account.lastLoginAt,
        created_at: account.createdAt,
        // First-run gate (F1-7): server-derived, never a client flag. Every
        // console entry point reads this one field to decide whether the
        // account still owes /platform/welcome.
        onboarding: await this.onboarding.stateFor(account.id),
      },
    };
  }

  @Patch('auth/me')
  @AuthLayer('l1')
  @Idempotent()
  async updateMe(@CurrentPrincipal() principal: L1Principal, @Body() body: { display_name?: string }): Promise<{ ok: true }> {
    if (typeof body.display_name !== 'string' || body.display_name.trim().length < 1 || body.display_name.length > 256) {
      throw ApiError.validation({ display_name: '1..256 characters' });
    }
    await this.accounts.updateDisplayName(principal.id, body.display_name.trim());
    return { ok: true };
  }

  // ── authenticated: first-run onboarding completion + consent (F1-7) ───────

  /**
   * Close the first-run gate. Consent is mandatory: without it the account
   * would own an auto-provisioned workspace nobody agreed to (ADR-001 creates
   * the personal org before this screen renders), so a body lacking
   * `consented: true` is refused rather than recorded as agreement.
   *
   * `skipped` means "skip the optional name/workspace personalization" — it
   * never bypasses the terms. Skipping is a legitimate completion, which is
   * what makes the gate satisfiable exactly once without trapping anyone.
   *
   * 409 when the client is consenting against a stale terms version (the
   * screen re-renders the current copy and asks again).
   */
  @Post('auth/me/onboarding/welcome')
  @AuthLayer('l1')
  @Idempotent()
  @RateLimit({ name: 'onboarding-welcome', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async completeOnboarding(
    @CurrentPrincipal() principal: L1Principal,
    @Body() body: { consented?: boolean; skipped?: boolean; terms_version?: string },
  ): Promise<{ ok: true; onboarding: OnboardingState }> {
    if (body.consented !== true) {
      throw ApiError.validation({ consent: 'consent to the terms is required to continue' });
    }
    if (typeof body.terms_version !== 'string' || body.terms_version.length === 0) {
      throw ApiError.validation({ terms_version: 'required' });
    }
    const onboarding = await this.onboarding.complete({
      accountId: principal.id,
      skipped: body.skipped === true,
      termsVersion: body.terms_version,
    });
    return { ok: true, onboarding };
  }

  // ── authenticated: password ────────────────────────────────────────────────

  @Post('auth/me/password')
  @AuthLayer('l1')
  @RateLimit({ name: 'pw-change', capacity: 5, refillPerSecond: 0.02, scope: 'principal' })
  async changePassword(@CurrentPrincipal() principal: L1Principal, @Body() body: { current_password?: string; new_password?: string }): Promise<{ ok: true }> {
    if (typeof body.current_password !== 'string' || typeof body.new_password !== 'string') {
      throw ApiError.validation({ current_password: 'required', new_password: 'required' });
    }
    await this.password.changePassword(principal.id, body.current_password, body.new_password);
    return { ok: true }; // every session (including this one) is revoked — the client re-authenticates
  }

  @Post('auth/me/password/set')
  @AuthLayer('l1')
  @RateLimit({ name: 'pw-set', capacity: 5, refillPerSecond: 0.02, scope: 'principal' })
  async setPassword(@CurrentPrincipal() principal: L1Principal, @Body() body: { new_password?: string }): Promise<{ ok: true }> {
    if (typeof body.new_password !== 'string') {
      throw ApiError.validation({ new_password: 'required' });
    }
    await this.password.setPassword(principal.id, body.new_password);
    return { ok: true };
  }

  @Post('auth/me/email-verification/request')
  @AuthLayer('l1')
  @RateLimit({ name: 'emailverify-request', capacity: 3, refillPerSecond: 0.02, scope: 'principal' })
  async requestVerification(@CurrentPrincipal() principal: L1Principal, @Req() req: FastifyRequest): Promise<{ ok: true }> {
    await this.password.requestEmailVerification(principal.id, req.ip ?? null);
    return { ok: true };
  }

  // ── authenticated: sessions ────────────────────────────────────────────────

  @Get('auth/me/sessions')
  @AuthLayer('l1')
  async sessions(@CurrentPrincipal() principal: L1Principal) {
    return { sessions: await this.password.listSessions(principal.id) };
  }

  @Post('auth/me/sessions/revoke-all')
  @AuthLayer('l1')
  @Idempotent()
  async revokeAll(@CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.password.revokeAllSessions(principal.id);
    return { ok: true };
  }

  @Post('auth/me/sessions/:sid/revoke')
  @AuthLayer('l1')
  async revokeOne(@CurrentPrincipal() principal: L1Principal, @Param('sid') sid: string): Promise<{ ok: true }> {
    await this.password.revokeSession(principal.id, sid);
    return { ok: true };
  }

  // ── authenticated: MFA ─────────────────────────────────────────────────────

  @Get('auth/mfa')
  @AuthLayer('l1')
  async mfaStatus(@CurrentPrincipal() principal: L1Principal) {
    return this.mfa.status(principal.id);
  }

  /** Returns the secret + otpauth URI exactly once — the QR payload. */
  @Post('auth/mfa/totp/enroll')
  @AuthLayer('l1')
  @RateLimit({ name: 'mfa-enroll', capacity: 3, refillPerSecond: 0.01, scope: 'principal' })
  async totpEnroll(@CurrentPrincipal() principal: L1Principal) {
    const account = await this.accounts.findById(principal.id);
    if (!account) {
      throw ApiError.notFound('account');
    }
    return this.mfa.enroll(principal.id, account.email);
  }

  /** Activates the enrollment; recovery codes are returned exactly once. */
  @Post('auth/mfa/totp/activate')
  @AuthLayer('l1')
  @RateLimit({ name: 'mfa-activate', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async totpActivate(@CurrentPrincipal() principal: L1Principal, @Body() body: { code?: string }) {
    if (!body.code) {
      throw ApiError.validation({ code: '6-digit code required' });
    }
    return this.mfa.activate(principal.id, body.code);
  }

  @Post('auth/mfa/totp/disable')
  @AuthLayer('l1')
  @RateLimit({ name: 'mfa-disable', capacity: 5, refillPerSecond: 0.02, scope: 'principal' })
  async totpDisable(@CurrentPrincipal() principal: L1Principal, @Body() body: { code?: string }): Promise<{ ok: true }> {
    if (!body.code) {
      throw ApiError.validation({ code: 'a live TOTP or recovery code is required' });
    }
    await this.mfa.disable(principal.id, body.code);
    return { ok: true };
  }

  /** Mint a step-up proof (X-MFA-Proof) after a live second factor. */
  @Post('auth/mfa/proof')
  @AuthLayer('l1')
  @RateLimit({ name: 'mfa-proof', capacity: 10, refillPerSecond: 0.1, scope: 'principal' })
  async proof(@CurrentPrincipal() principal: L1Principal, @Body() body: { code?: string }) {
    if (!body.code) {
      throw ApiError.validation({ code: 'a live TOTP or recovery code is required' });
    }
    return this.mfa.mintProof(principal.id, body.code);
  }

  @Post('auth/mfa/recovery/rotate')
  @AuthLayer('l1')
  @RateLimit({ name: 'mfa-recovery-rotate', capacity: 3, refillPerSecond: 0.01, scope: 'principal' })
  async rotateRecovery(@CurrentPrincipal() principal: L1Principal, @Body() body: { code?: string }) {
    if (!body.code) {
      throw ApiError.validation({ code: 'a live TOTP or recovery code is required' });
    }
    return this.mfa.rotateRecoveryCodes(principal.id, body.code);
  }

  // ── authenticated: self-service deletion (H-6) ────────────────────────────

  /** Stages deletion behind re-auth (password + live second factor when enrolled). */
  @Post('auth/me/delete')
  @AuthLayer('l1')
  @Idempotent()
  @RateLimit({ name: 'account-delete', capacity: 3, refillPerSecond: 0.01, scope: 'principal' })
  async requestDeletion(@CurrentPrincipal() principal: L1Principal, @Body() body: { password?: string; code?: string }): Promise<{ scheduled_purge_at: string }> {
    return this.deletion.request({ accountId: principal.id, password: body.password, factor: body.code });
  }

  @Post('auth/me/delete/cancel')
  @AuthLayer('l1')
  @Idempotent()
  @RateLimit({ name: 'account-delete-cancel', capacity: 5, refillPerSecond: 0.02, scope: 'principal' })
  async cancelDeletion(@CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.deletion.cancel(principal.id);
    return { ok: true };
  }

  @Get('auth/me/deletion-status')
  @AuthLayer('l1')
  async deletionStatus(@CurrentPrincipal() principal: L1Principal): Promise<{ deletion: { scheduled_purge_at: string } | null }> {
    return { deletion: await this.deletion.status(principal.id) };
  }

  // ── authenticated: email change (H-7) ─────────────────────────────────────

  /** Re-auth + uniqueness check → a code goes to the NEW address. */
  @Post('auth/me/email-change/request')
  @AuthLayer('l1')
  @RateLimit({ name: 'email-change-request', capacity: 3, refillPerSecond: 0.02, scope: 'principal' })
  async requestEmailChange(
    @CurrentPrincipal() principal: L1Principal,
    @Body() body: { new_email?: string; current_password?: string; code?: string },
    @Req() req: FastifyRequest,
  ): Promise<{ ok: true }> {
    if (!body.new_email || typeof body.new_email !== 'string') {
      throw ApiError.validation({ new_email: 'required' });
    }
    return this.emailChange.request({
      accountId: principal.id,
      newEmail: body.new_email,
      password: body.current_password,
      factor: body.code,
      requestIp: req.ip ?? null,
    });
  }

  @Post('auth/me/email-change/confirm')
  @AuthLayer('l1')
  @RateLimit({ name: 'email-change-confirm', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async confirmEmailChange(@CurrentPrincipal() principal: L1Principal, @Body() body: { new_email?: string; code?: string }): Promise<{ ok: true }> {
    if (!body.new_email || typeof body.new_email !== 'string') {
      throw ApiError.validation({ new_email: 'required' });
    }
    if (!body.code || typeof body.code !== 'string') {
      throw ApiError.validation({ code: 'the code is 8 digits' });
    }
    return this.emailChange.confirm({ accountId: principal.id, newEmail: body.new_email, code: body.code });
  }
}
