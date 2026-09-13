import { CanActivate, ExecutionContext, Inject, Injectable, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error';
import { L1Principal, L2Principal, PlatformRole } from '../auth/principal';
import { PLATFORM_STAFF_DIRECTORY_PORT, PlatformStaffDirectoryPort } from '../auth/ports';

/**
 * Platform-role guard for staff surfaces (the Neryva-studio staff overlay —
 * never a customer-org axis; access-model: platform RBAC stays separate from
 * org roles). Register with @UseGuards(PlatformStaffGuard) + @StaffRoles(...)
 * and an @AuthLayer.
 *
 * Resolution authority (auth_plan.md D1): L1 sessions resolve through
 * PlatformStaffDirectoryPort (the platform_staff table, 60s cache) so a
 * revocation or JIT expiry bites on the next request — the `platform_role`
 * JWT claim is an optimization, never authoritative. L2 keys keep the legacy
 * role column on the key row. An unbound directory (staff module disabled)
 * denies L1 callers — fail closed, same posture as the unbound session
 * registry. Impersonated sessions are read-only and never touch staff surfaces.
 */
const STAFF_KEY = 'staffRoles';

export const StaffRoles = (...roles: PlatformRole[]): MethodDecorator & ClassDecorator => SetMetadata(STAFF_KEY, roles);

@Injectable()
export class PlatformStaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(PLATFORM_STAFF_DIRECTORY_PORT) private readonly directory?: PlatformStaffDirectoryPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(STAFF_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) {
      throw ApiError.deniedByDefault();
    }
    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: L1Principal | L2Principal }>();
    const principal = request.principal;
    if (!principal) {
      throw ApiError.unauthenticated();
    }
    if (principal.kind === 'l2') {
      const role: string = principal.role;
      if (!role || !required.includes(role as PlatformRole)) {
        throw ApiError.forbidden('Platform staff role required', { required });
      }
      return true;
    }
    if (principal.kind === 'l1') {
      if (principal.imp) {
        throw ApiError.forbidden('Impersonated sessions are read-only — staff surfaces are closed to them');
      }
      const resolution = this.directory ? await this.directory.resolve(principal.id) : { role: null, expiresAt: null };
      if (!resolution.role || !required.includes(resolution.role)) {
        throw ApiError.forbidden('Platform staff role required', { required });
      }
      return true;
    }
    throw ApiError.unauthenticated();
  }
}
