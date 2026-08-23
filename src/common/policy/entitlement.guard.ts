import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error';
import { Principal } from '../auth/principal';
import { EntitlementState, ORG_ACCESS_PORT, OrgAccessPort } from '../auth/ports';

export const ENTITLEMENT_KEY = 'requireEntitlement';

/**
 * Product entitlement guard (access-model entitlement-state table):
 *   none/expired       → 403 entitlement_required (every method)
 *   trial/active       → allowed
 *   past_due/suspended → GET/HEAD allowed (read-only), writes → 402 past_due
 */
export const RequireEntitlement = (product: string): MethodDecorator & ClassDecorator =>
  SetMetadata(ENTITLEMENT_KEY, product);

@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ORG_ACCESS_PORT) private readonly orgAccess: OrgAccessPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const product =
      this.reflector.getAllAndOverride<string | undefined>(ENTITLEMENT_KEY, [context.getHandler(), context.getClass()]) ?? undefined;
    if (!product) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal; orgId?: string }>();
    const principal = request.principal;
    if (!principal) {
      throw ApiError.unauthenticated();
    }

    const params = request.params as Record<string, string | undefined>;
    const headerOrg = request.headers['x-neryva-org'];
    const orgId = request.orgId ?? params?.orgId ?? (Array.isArray(headerOrg) ? headerOrg[0] : headerOrg);
    if (!orgId) {
      throw ApiError.validation({ org: 'orgId route param or X-Neryva-Org header required' });
    }
    request.orgId = orgId;

    const state: EntitlementState = await this.orgAccess.getEntitlementState(orgId, product);
    if (state === 'none' || state === 'expired') {
      throw ApiError.entitlementRequired(product);
    }
    if (state === 'past_due' || state === 'suspended') {
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        throw ApiError.pastDue(product);
      }
    }
    return true;
  }
}
