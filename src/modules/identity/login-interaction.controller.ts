import { All, Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import { Public } from '../../common/auth/decorators';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { AccountsService, normalizeEmail } from './accounts.service';
import { CredentialsService } from './credentials.service';
import { EmailCodeService } from './email-code.service';
import { MfaService } from './mfa.service';
import { OIDC_PROVIDER } from './oidc/oidc-provider.token';
import { issueFirstPartyGrant } from './oidc/grant-issue.helper';
import { socialProviders } from './social/social.config';

/**
 * The login interaction (Δ1: email one-time code, primary; password,
 * secondary). oidc-provider redirects the browser here with the interaction
 * uid; this controller resolves the login then finishes the interaction —
 * the OP takes over again for code issuance + PKCE.
 *
 * The HTML is deliberately minimal, CSP-clean (no external assets), and
 * form-action-locked to itself.
 */
@Controller('login')
export class LoginInteractionController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly provider: () => Provider,
    private readonly accounts: AccountsService,
    private readonly credentials: CredentialsService,
    private readonly emailCodes: EmailCodeService,
    private readonly mfa: MfaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  @Public()
  @Get(':uid')
  show(@Param('uid') uid: string, @Res() reply: FastifyReply): void {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; script-src 'none'");
    reply.send(this.page('Sign in to Neryva', 'Enter your email — we will send you a one-time code.', uid));
  }

  /** Step 1: email → upsert account → send code. */
  @Public()
  @RateLimit({ name: 'login-email', capacity: 5, refillPerSecond: 0.05, scope: 'ip' })
  @Post(':uid/email')
  @HttpCode(200)
  async submitEmail(@Param('uid') uid: string, @Body() body: { email?: string }, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.assertInteraction(req, reply);
    let email: string;
    try {
      email = normalizeEmail(String(body.email ?? ''));
    } catch {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.status(400).send(this.page('Sign in to Neryva', 'That email address is not valid.', uid, body.email ?? ''));
      return;
    }

    // Upsert-on-login: an unknown email creates the account (no signup
    // wall, no enumeration signal); a verified code marks it verified.
    const { account } = await this.accounts.upsertByEmail(email);
    const issue = await this.emailCodes.issue(account.id, req.ip ?? null);
    if (!issue.ok) {
      reply.header('retry-after', '60');
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.status(429).send(this.page('Sign in to Neryva', 'Too many codes requested. Try again in a few minutes.', uid, email));
      return;
    }
    await this.email.sendTemplate({
      template: 'identity.login-code',
      to: account.email,
      vars: { code: issue.code, ttl_minutes: String(Math.round(env.IDENTITY_EMAIL_CODE_TTL_SECONDS / 60)) },
      metadata: { accountId: account.id, interaction: uid },
    });
    await this.audit.add({
      action: 'login.code_sent',
      resourceType: 'account',
      resourceId: account.id,
      actorType: 'system',
      details: { email_domain: account.email.split('@')[1] ?? '' },
    });

    reply.header('content-type', 'text/html; charset=utf-8');
    reply.send(this.page('Check your inbox', `We sent a code to ${email}. Enter it below.`, uid, email, 'code'));
  }

  /** Step 2: verify the code → interactionFinished (the OP resumes). */
  @Public()
  @RateLimit({ name: 'login-verify', capacity: 10, refillPerSecond: 0.1, scope: 'ip' })
  @Post(':uid/verify')
  async verifyCode(@Param('uid') uid: string, @Body() body: { email?: string; code?: string }, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const interaction = await this.assertInteraction(req, reply);
    let email: string;
    try {
      email = normalizeEmail(String(body.email ?? ''));
    } catch {
      throw ApiError.validation({ email: 'invalid email address' });
    }
    const code = String(body.code ?? '').trim();
    if (!/^\d{8}$/.test(code)) {
      throw ApiError.validation({ code: 'the code is 8 digits' });
    }

    const account = await this.accounts.findByEmail(email);
    if (!account) {
      await this.events.emit(EngineEvents.LoginFailure, { reason: 'unknown_account' });
      throw ApiError.unauthenticated('Invalid code');
    }
    const verified = await this.emailCodes.verify(account.id, code);
    if (!verified.ok) {
      await this.emailCodes.registerFailedAttempt(account.id);
      await this.events.emit(EngineEvents.LoginFailure, { reason: `code_${verified.reason}`, accountId: account.id });
      await this.audit.add({
        action: 'login.failure',
        resourceType: 'account',
        resourceId: account.id,
        actorType: 'account',
        actorId: account.id,
        details: { reason: `code_${verified.reason}` },
      });
      throw ApiError.unauthenticated('Invalid code');
    }
    if (!(await this.emailCodes.consume(account.id, code))) {
      // Lost the single-use race — treat as invalid, never as a second use.
      throw ApiError.unauthenticated('Invalid code');
    }

    await this.challengeOrFinish(req, reply, uid, interaction, account.id, 'email_code', email);
  }

  /** Secondary path: password (accounts that opted into one). */
  @Public()
  @RateLimit({ name: 'login-password', capacity: 10, refillPerSecond: 0.05, scope: 'ip' })
  @Post(':uid/password')
  async verifyPassword(@Param('uid') uid: string, @Body() body: { email?: string; password?: string }, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const interaction = await this.assertInteraction(req, reply);
    const email = normalizeEmail(String(body.email ?? ''));
    const password = String(body.password ?? '');
    const account = await this.accounts.findByEmail(email);
    // AUTH-3.2: password material lives in account_credentials — one extra
    // read for the passwordless branch, enumeration resistance preserved
    // (unknown email and known-passwordless take the same dummy-verify path).
    const storedHash = account ? await this.credentials.getPasswordHash(account.id) : null;
    if (!account || !storedHash) {
      // Enumeration resistance: uniform failure with a dummy verify for timing.
      await this.credentials.verifyPassword(DUMMY_ARGON2_HASH, password);
      await this.events.emit(EngineEvents.LoginFailure, { reason: 'password_unknown' });
      throw ApiError.unauthenticated('Invalid email or password');
    }
    const ok = await this.credentials.verifyPassword(storedHash, password);
    if (!ok) {
      await this.events.emit(EngineEvents.LoginFailure, { reason: 'password_invalid', accountId: account.id });
      await this.audit.add({
        action: 'login.failure',
        resourceType: 'account',
        resourceId: account.id,
        actorType: 'account',
        actorId: account.id,
        details: { reason: 'password_invalid' },
      });
      throw ApiError.unauthenticated('Invalid email or password');
    }
    if (this.credentials.needsRehash(storedHash)) {
      await this.credentials.setPasswordHash(account.id, await this.credentials.hashPassword(password));
    }
    await this.challengeOrFinish(req, reply, uid, interaction, account.id, 'password', email);
  }

  /**
   * The MFA challenge step (H-5): when the account has TOTP enrolled, the
   * first factor alone never issues a session — the interaction stays open
   * (the OP owns it) and a TOTP or recovery code must be presented at
   * /login/:uid/mfa before interactionFinished runs.
   */
  @Public()
  @RateLimit({ name: 'login-mfa', capacity: 10, refillPerSecond: 0.1, scope: 'ip' })
  @Post(':uid/mfa')
  async verifyMfa(
    @Param('uid') uid: string,
    @Body() body: { email?: string; code?: string; first_factor?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const interaction = await this.assertInteraction(req, reply);
    let email: string;
    try {
      email = normalizeEmail(String(body.email ?? ''));
    } catch {
      throw ApiError.validation({ email: 'invalid email address' });
    }
    const code = String(body.code ?? '').trim();
    if (code.length === 0) {
      throw ApiError.validation({ code: 'a live TOTP or recovery code is required' });
    }
    const firstFactor = body.first_factor === 'email_code' ? 'email_code' : 'password';

    const account = await this.accounts.findByEmail(email);
    // No account / no enrollment ⇒ this endpoint can NEVER complete a login
    // on its own — it only finishes interactions that passed a first factor.
    if (!account || !(await this.mfa.requiresSecondFactor(account.id))) {
      await this.events.emit(EngineEvents.LoginFailure, { reason: 'mfa_not_enrolled' });
      throw ApiError.unauthenticated('Invalid code');
    }
    const ok = await this.mfa.verifyLoginFactor(account.id, code);
    if (!ok) {
      await this.events.emit(EngineEvents.LoginFailure, { reason: 'mfa_invalid', accountId: account.id });
      await this.audit.add({
        action: 'login.failure',
        resourceType: 'account',
        resourceId: account.id,
        actorType: 'account',
        actorId: account.id,
        details: { reason: 'mfa_invalid' },
      });
      throw ApiError.unauthenticated('Invalid code');
    }
    await this.finishLogin(req, reply, uid, interaction, account.id, firstFactor, true);
  }

  @Public()
  @All('*')
  fallback(): void {
    throw ApiError.notFound('login route');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** oidc-provider's interaction APIs take the raw node req/res — Fastify keeps them at .raw. */
  private async assertInteraction(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ returnTo?: string; params?: { scope?: string; client_id?: string } }> {
    const provider = this.provider();
    const details = (await provider.interactionDetails(req.raw as never, reply.raw as never)) as unknown as {
      returnTo?: string;
      params?: { scope?: string; client_id?: string };
    };
    return details;
  }

  /** Gate between the first factor and session issuance: enrolled ⇒ challenge step. */
  private async challengeOrFinish(
    req: FastifyRequest,
    reply: FastifyReply,
    uid: string,
    interaction: { returnTo?: string },
    accountId: string,
    method: 'email_code' | 'password',
    email: string,
  ): Promise<void> {
    if (await this.mfa.requiresSecondFactor(accountId)) {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.send(this.page('Two-factor authentication', 'Enter a code from your authenticator app (or a recovery code).', uid, email, 'mfa', method));
      return;
    }
    await this.finishLogin(req, reply, uid, interaction, accountId, method);
  }

  private async finishLogin(
    req: FastifyRequest,
    reply: FastifyReply,
    uid: string,
    interaction: { returnTo?: string; params?: { scope?: string; client_id?: string } },
    accountId: string,
    method: string,
    mfa = false,
  ): Promise<void> {
    const provider = this.provider();
    await this.accounts.markLoginSuccess(accountId);
    // Only the email-code path proves mailbox control — a password login
    // must NOT mark the address verified (verification is its own flow).
    if (method === 'email_code') {
      await this.accounts.markEmailVerified(accountId);
    }
    await this.audit.add({
      action: 'login.success',
      resourceType: 'account',
      resourceId: accountId,
      actorType: 'account',
      actorId: accountId,
      details: { method, mfa },
    });
    await this.events.emit(EngineEvents.LoginSuccess, { accountId, method });
    // First-party grant: no consent screen exists, so the requested scopes
    // are granted here — without them the OP refuses the code with
    // access_denied (...no scope was granted).
    const clientId = interaction.params?.client_id ?? 'neryva-console';
    const grantId = await issueFirstPartyGrant(provider, {
      accountId,
      clientId,
      scope: interaction.params?.scope,
    });
    await provider.interactionFinished(req.raw as never, reply.raw as never, {
      login: { accountId, remember: true },
      consent: { grantId },
    });
    // The provider already ended the raw response with the resume redirect
    // above — sending anything else here writes to an ended stream and
    // intermittently 500s with FST_ERR_REP_ALREADY_SENT (P1-05). The
    // interaction's own returnTo is the only redirect the client needs.
  }

  private page(title: string, message: string, uid: string, email = '', mode: 'email' | 'code' | 'mfa' = 'email', firstFactor: 'password' | 'email_code' = 'password'): string {
    const form =
      mode === 'email'
        ? `<form method="post" action="/login/${uid}/email">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
<button type="submit">Send code</button></form>`
        : mode === 'mfa'
          ? `<form method="post" action="/login/${escapeHtml(uid)}/mfa">
<input type="hidden" name="email" value="${escapeHtml(email)}">
<input type="hidden" name="first_factor" value="${firstFactor}">
<label for="code">Authentication code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
<button type="submit">Verify</button></form>`
          : `<form method="post" action="/login/${uid}/verify">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
<label for="code">One-time code</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="one-time-code" required>
<button type="submit">Verify</button></form>`;
    // Social buttons render only for providers enabled on this deployment
    // (doc-06 Δ1: federated login joins the same interaction flow).
    const socialButtons = socialProviders()
      .map(
        (p) =>
          `<a class="social" href="/login/${escapeHtml(uid)}/social/${escapeHtml(p.key)}">Continue with ${escapeHtml(p.label)}</a>`,
      )
      .join('');
    const socialBlock = socialButtons
      ? `<div class="divider"><span>or</span></div><div class="socials">${socialButtons}</div>`
      : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:32px;width:min(360px,90vw)}
label{display:block;font-size:13px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:15px}
button{margin-top:16px;width:100%;padding:10px;background:#111;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer}
p.hint{color:#555;font-size:14px}
.divider{display:flex;align-items:center;gap:12px;color:#999;font-size:12px;margin:20px 0 8px}
.divider::before,.divider::after{content:"";flex:1;border-top:1px solid #e5e5e5}
.socials{display:grid;gap:8px}
a.social{display:block;text-align:center;padding:10px;border:1px solid #ccc;border-radius:6px;color:#111;text-decoration:none;font-size:14px}
a.social:hover{background:#f5f5f5}</style></head>
<body><div class="card"><h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(title)}</h1>
<p class="hint">${escapeHtml(message)}</p>${form}${socialBlock}</div></body></html>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A syntactically valid argon2id hash of an unguessable value: keeps the
// unknown-account timing profile identical to a real verify.
const DUMMY_ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQAAAAAAAAAAA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';
