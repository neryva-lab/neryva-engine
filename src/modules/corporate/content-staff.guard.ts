import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../../common/http/api-error';
import { Principal } from '../../common/auth/principal';
import { CONTENT_STAFF_REPOSITORY } from './repositories/repository-tokens';
import type { IContentStaffRepository } from './repositories/content-staff.repository';

/**
 * Content-staff gate (corporate E-3): L1 + a row in corporate_content_staff
 * (the reborn website admin/editor role — ADR-004 D4). Grants are managed
 * by platform operators only (super_admin L2), never by org roles: content
 * is a company surface, not an org surface.
 *
 * Persistence-blind (P3): the grant lookup goes through
 * `IContentStaffRepository`. Corporate tables are global (non-tenant).
 */
@Injectable()
export class ContentStaffGuard implements CanActivate {
  constructor(@Inject(CONTENT_STAFF_REPOSITORY) private readonly staff: IContentStaffRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
    const principal = request.principal;
    if (!principal || principal.kind !== 'l1') {
      throw ApiError.forbidden('Content admin is an L1 staff surface');
    }
    if (!(await this.staff.isContentStaff(principal.id))) {
      throw ApiError.forbidden('Content staff grant required');
    }
    return true;
  }
}
