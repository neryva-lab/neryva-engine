import { eq } from 'drizzle-orm';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { Principal } from '../../common/auth/principal';
import { corporateContentStaff } from './public.schema';

/**
 * Content-staff gate (corporate E-3): L1 + a row in corporate_content_staff
 * (the reborn website admin/editor role — ADR-004 D4). Grants are managed
 * by platform operators only (super_admin L2), never by org roles: content
 * is a company surface, not an org surface.
 */
@Injectable()
export class ContentStaffGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
    const principal = request.principal;
    if (!principal || principal.kind !== 'l1') {
      throw ApiError.forbidden('Content admin is an L1 staff surface');
    }
    const rows = await this.db.root
      .select({ accountId: corporateContentStaff.accountId })
      .from(corporateContentStaff)
      .where(eq(corporateContentStaff.accountId, principal.id))
      .limit(1);
    if (!rows[0]) {
      throw ApiError.forbidden('Content staff grant required');
    }
    return true;
  }
}
