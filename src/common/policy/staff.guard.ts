import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error';
import { L1Principal, L2Principal, PlatformRole } from '../auth/principal';

/**
 * Platform-role guard for staff surfaces (the Neryva-staff overlay — never
 * a customer-org axis; access-model: platform RBAC stays separate from org
 * roles). Accepts L1 sessions carrying a platform_role claim or L2 keys
 * whose role qualifies; deny-by-default otherwise. Register with
 * @UseGuards(PlatformStaffGuard) + @StaffRoles(...) and an @AuthLayer.
 */
const STAFF_KEY = 'staffRoles';

export const StaffRoles = (...roles: PlatformRole[]): MethodDecorator & ClassDecorator => SetMetadata(STAFF_KEY, roles);

@Injectable()
export class PlatformStaffGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(STAFF_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) {
      throw ApiError.deniedByDefault();
    }
    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: L1Principal | L2Principal }>();
    const principal = request.principal;
    if (!principal) {
      throw ApiError.unauthenticated();
    }
    const role: string | null = principal.kind === 'l1' ? principal.platformRole ?? '' : principal.kind === 'l2' ? principal.role : '';
    if (!role || !required.includes(role as PlatformRole)) {
      throw ApiError.forbidden('Platform staff role required', { required });
    }
    return true;
  }
}
