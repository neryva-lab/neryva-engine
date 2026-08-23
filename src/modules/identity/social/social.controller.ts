import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import { Public, AuthLayer, CurrentPrincipal } from '../../../common/auth/decorators';
import { L1Principal } from '../../../common/auth/principal';
import { RateLimit } from '../../../common/http/rate-limit';
import { AuditService } from '../../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../../common/events/event-bus';
import { OIDC_PROVIDER } from '../identity.module';
import { AccountsService } from '../accounts.service';
import { SocialAccountService } from './social-account.service';
import { SocialLoginService } from './social-login.service';
import { SOCIAL_CALLBACK_PATH, socialProviders } from './social.config';

/**
 * The social login surface (doc-06 Δ1). Three zones:
 *
 *  - `/login/:uid/social/:provider` — initiate: validates the interaction
 *    uid against the OP (no open-redirecting strangers to IdPs), stores
 *    single-use state (uid + nonce + PKCE), redirects to the IdP.
 *  - `/login/social/callback/:provider` — GET (Google/GitHub/Microsoft) and
 *    POST (Apple form_post): consumes state, completes the handshake,
 *    finishes the OP interaction — identical session semantics to the
 *    email-code path (one login surface, one L1 contract).
 *  - `/auth/me/identities` — L1 account management (the /auth/me surface convention): list linked
 *    identities, unlink (with the lockout guard).
 */
@Controller()
export class SocialController {
  constructor(
    private readonly social: SocialLoginService,
    private readonly socialAccounts: SocialAccountService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    @Inject(OIDC_PROVIDER) private readonly provider: () => Provider,
  ) {}

  /** Providers enabled on this deployment — the login page renders exactly these. */
  @Public()
  @Get('login/providers')
  configuredProviders(): { providers: Array<{ key: string; label: string }> } {
    return { providers: socialProviders().map((p) => ({ key: p.key, label: p.label })) };
  }

  @Public()
  @Get('login/:uid/social/:provider')
  @RateLimit({ name: 'social-initiate', capacity: 10, refillPerSecond: 0.2 })
  async initiate(
    @Param('uid') uid: string,
    @Param('provider') provider: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Bind the redirect to a REAL pending interaction — an attacker must
    // already hold an authorize handshake to get sent to an IdP.
    try {
      await this.provider().interactionDetails(req.raw as never, reply.raw as never);
    } catch {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.status(410).send(this.errorPage('This sign-in session expired', 'Start again from the application.'));
      return;
    }
    try {
      const { redirectUrl } = await this.social.initiate(provider, uid);
      reply.redirect(redirectUrl, 302);
    } catch (err) {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.status((err as Error).message.includes('not configured') ? 404 : 400).send(this.errorPage('Sign-in could not start', (err as Error).message));
    }
  }

  /** Google / GitHub / Microsoft return by query. */
  @Public()
  @Get(`${SOCIAL_CALLBACK_PATH.slice(1)}/:provider`)
  @RateLimit({ name: 'social-callback', capacity: 20, refillPerSecond: 0.5 })
  async callbackGet(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.callback(provider, { code, state, error }, req, reply);
  }

  /** Apple returns by form_post (urlencoded body — parser registered in main.ts). */
  @Public()
  @Post(`${SOCIAL_CALLBACK_PATH.slice(1)}/:provider`)
  @RateLimit({ name: 'social-callback', capacity: 20, refillPerSecond: 0.5 })
  async callbackPost(
    @Param('provider') provider: string,
    @Body() body: { code?: string; state?: string; error?: string },
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.callback(provider, body, req, reply);
  }

  private async callback(
    provider: string,
    params: { code?: string; state?: string; error?: string },
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const fail = (title: string, detail: string, status = 400): void => {
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.status(status).send(this.errorPage(title, detail));
    };

    if (!params.state) {
      return fail('Missing state', 'The sign-in session state was absent — start again.');
    }
    const consumed = await this.social.consumeState(params.state);
    if (!consumed || consumed.provider !== provider) {
      return fail('Invalid state', 'This sign-in link was already used or expired. Start again.', 410);
    }
    if (params.error) {
      // User cancelled / IdP refused — back to the login page, no error leak.
      return reply.redirect(`/login/${consumed.uid}`, 302);
    }
    if (!params.code) {
      return fail('Missing authorization code', 'The provider did not return an authorization code.');
    }

    let result: { provider: string; accountId: string };
    try {
      result = await this.social.complete(provider, params.code, consumed);
    } catch (err) {
      await this.events.emit(EngineEvents.LoginFailure, { reason: `social_${provider}` });
      await this.audit.add({
        action: 'login.failure',
        resourceType: 'account',
        actorType: 'system',
        details: { method: `social:${provider}`, reason: (err as Error).message.slice(0, 200) },
      });
      return fail('Sign-in failed', 'The provider could not be verified. Please try again.');
    }

    await this.accounts.markLoginSuccess(result.accountId);
    await this.audit.add({
      action: 'login.success',
      resourceType: 'account',
      resourceId: result.accountId,
      actorType: 'account',
      actorId: result.accountId,
      details: { method: `social:${result.provider}` },
    });
    await this.events.emit(EngineEvents.LoginSuccess, { accountId: result.accountId, method: `social:${result.provider}` });

    try {
      const details = (await this.provider().interactionDetails(req.raw as never, reply.raw as never)) as unknown as { returnTo?: string };
      await this.provider().interactionFinished(req.raw as never, reply.raw as never, {
        login: { accountId: result.accountId, remember: true },
      });
      reply.redirect(details.returnTo ?? '/', 302);
    } catch {
      // The interaction expired while the user was at the IdP.
      return fail('Sign-in session expired', 'The application session ended while you were at the provider. Start again.', 410);
    }
  }

  // ── Account identity management (L1) ─────────────────────────────────────

  @Get('auth/me/identities')
  @AuthLayer('l1')
  async listIdentities(@CurrentPrincipal() principal: L1Principal): Promise<{ identities: unknown[] }> {
    return { identities: await this.socialAccounts.listIdentities(principal.id) };
  }

  @Post('auth/me/identities/:identityId/unlink')
  @AuthLayer('l1')
  @RateLimit({ name: 'social-unlink', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async unlink(
    @Param('identityId') identityId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.socialAccounts.unlink({ accountId: principal.id, identityId });
    return { ok: true };
  }

  private errorPage(title: string, detail: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:32px;width:min(380px,90vw);text-align:center}
a{color:#0645ad}</style></head>
<body><div class="card"><h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(title)}</h1>
<p style="color:#555;font-size:14px">${escapeHtml(detail)}</p></div></body></html>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
