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
 */
@Controller()
export class AccountController {
  constructor(
    private readonly password: PasswordService,
    private readonly mfa: MfaService,
    private readonly accounts: AccountsService,
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
      },
    };
  }

  @Patch('auth/me')
  @AuthLayer('l1')
  async updateMe(@CurrentPrincipal() principal: L1Principal, @Body() body: { display_name?: string }): Promise<{ ok: true }> {
    if (typeof body.display_name !== 'string' || body.display_name.trim().length < 1 || body.display_name.length > 256) {
      throw ApiError.validation({ display_name: '1..256 characters' });
    }
    await this.accounts.updateDisplayName(principal.id, body.display_name.trim());
    return { ok: true };
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
}
