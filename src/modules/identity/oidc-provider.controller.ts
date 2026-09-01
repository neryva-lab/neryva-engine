import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import { Public } from '../../common/auth/decorators';
import { OIDC_PROVIDER } from './oidc/oidc-provider.token';

/**
 * Mounts the entire OP under /auth — every oidc-provider route
 * (authorize, token, userinfo, jwks, revocation, end_session, discovery)
 * is served by the provider itself with its own protocol-level security.
 * This controller is a pure pass-through on the raw node req/res (Fastify
 * hosts them at .raw — exactly what the provider's handler expects).
 */
@Controller('auth')
export class OidcProviderController {
  constructor(@Inject(OIDC_PROVIDER) private readonly provider: () => Provider) {}

  @Public()
  @All('*')
  handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    this.provider().callback()(req.raw, reply.raw);
  }
}
