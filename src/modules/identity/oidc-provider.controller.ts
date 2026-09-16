import { All, Body, Controller, Inject, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import { Public } from '../../common/auth/decorators';
import { OIDC_PROVIDER } from './oidc/oidc-provider.token';
import { toProviderRequest } from './oidc/provider-request.helper';

/**
 * Mounts the entire OP under /auth — every oidc-provider route
 * (authorize, token, userinfo, jwks, revocation, end_session, discovery)
 * is served by the provider itself with its own protocol-level security.
 * This controller is a pure pass-through on the raw node req/res (Fastify
 * hosts them at .raw — exactly what the provider's handler expects).
 *
 * Mount-prefix stripping: the provider's routes are relative to its issuer
 * (`IDENTITY_ISSUER=http://host/auth`), i.e. authorize is `/auth`, token is
 * `/token`. Nest delivers the FULL path (`/auth/auth`, `/auth/token`), so
 * the `/auth` mount prefix is stripped before delegating — the Express
 * `app.use('/auth', provider.callback())` equivalent. Without the strip,
 * `/auth/auth` mis-matches the provider's resume route (`/auth/:uid` with
 * uid='auth' → `SessionNotFound: authorization request has expired`) and
 * `POST /auth/token` matches nothing (`unrecognized route`, 404).
 *
 * NOTE: `GET /auth/me` never reaches the provider — Fastify prefers Nest's
 * explicit `AccountController` route (L1 `{account: …}` envelope) over this
 * wildcard. The console reads the account there; OP userinfo stays shadowed
 * by design.
 */
@Controller('auth')
export class OidcProviderController {
  constructor(@Inject(OIDC_PROVIDER) private readonly provider: () => Provider) {}

  @Public()
  @All('*')
  handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Body() body: unknown): void {
    const raw = req.raw as unknown as { url?: unknown };
    if (typeof raw.url === 'string') {
      raw.url = stripAuthMountPrefix(raw.url);
    }
    const providerReq = toProviderRequest(req.raw, body);
    this.provider().callback()(providerReq as never, reply.raw);
  }
}

/**
 * Rewrite a full inbound path to the provider-relative path by removing the
 * `/auth` mount prefix. Pure (unit-tested) so the controller stays trivial.
 */
export function stripAuthMountPrefix(url: string): string {
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  if (path === '/auth') {
    return `/${query}`;
  }
  if (path.startsWith('/auth/')) {
    return `${path.slice('/auth'.length)}${query}`;
  }
  return url;
}
