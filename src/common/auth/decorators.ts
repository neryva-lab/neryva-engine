import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthLayerKind, Principal } from './principal';

export const IS_PUBLIC_KEY = 'isPublic';

/** Explicitly unauthenticated route (the ONLY way to skip the auth guard). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export const AUTH_LAYERS_KEY = 'authLayers';

/**
 * Which token layers a route accepts. Absence of both @Public and @AuthLayer
 * means the composite guard rejects the request — deny-by-default.
 */
export const AuthLayer = (...layers: AuthLayerKind[]): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTH_LAYERS_KEY, layers);

export const REQUIRED_SCOPES_KEY = 'requiredScopes';

/** Scope requirement checked after authentication (wildcard `*` supported). */
export const RequireScopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

/** The authenticated principal resolved by the composite guard. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
    if (!request.principal) {
      throw new Error('CurrentPrincipal used on a route without @AuthLayer');
    }
    return request.principal;
  },
);
