import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error';
import { Principal } from '../auth/principal';
import { ORG_ACCESS_PORT, OrgAccessPort } from '../auth/ports';

export const ORG_ROLES_KEY = 'orgRoles';

/**
 * Membership-role requirement (access-model matrix). The org under test is
 * resolved from the `:orgId` route param or the X-Neryva-Org header — the
 * resolved org is attached to the request for the RLS layer downstream.
 */
export const Roles = (...roles: Array<'owner' | 'admin' | 'billing' | 'developer' | 'reader'>): MethodDecorator & ClassDecorator =>
  SetMetadata(ORG_ROLES_KEY, roles);

@Injectable()
export class OrgRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ORG_ACCESS_PORT) private readonly orgAccess: OrgAccessPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<Array<'owner' | 'admin' | 'billing' | 'developer' | 'reader'> | undefined>(ORG_ROLES_KEY, [context.getHandler(), context.getClass()]) ?? undefined;
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal; orgId?: string }>();
    const principal = request.principal;
    if (!principal) {
      throw ApiError.unauthenticated();
    }

    const params = request.params as Record<string, string | undefined>;
    const headerOrg = request.headers['x-neryva-org'];
    const orgId = params?.orgId ?? (Array.isArray(headerOrg) ? headerOrg[0] : headerOrg);
    if (!orgId) {
      throw ApiError.validation({ org: 'orgId route param or X-Neryva-Org header required' });
    }
    request.orgId = orgId;

    if (principal.kind !== 'l1') {
      throw ApiError.forbidden('Org surfaces are L1-only (console sessions)');
    }
    if (principal.imp) {
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        throw ApiError.forbidden('Impersonated sessions are read-only (support access)');
      }
    }

    const role = await this.orgAccess.getMembershipRole(principal.id, orgId);
    if (role === null) {
      throw ApiError.forbidden('Not a member of this organization');
    }
    if (!required.includes(role)) {
      throw ApiError.forbidden('Insufficient org role', { required, have: role });
    }
    return true;
  }
}
