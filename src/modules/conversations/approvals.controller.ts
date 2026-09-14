import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { ConversationsService } from './conversations.service';

/**
 * The approvals surface (REL-5.1/REL-5.3): the org's pending work is
 * DISCOVERABLE — the decision endpoint existed (`:runId/approvals/:id/
 * decision`) with nothing to find it by. Expired items are flagged at read
 * time; a pending window can be re-targeted (extended) with audit.
 */
@Controller('console/org/:orgId/approvals')
@AuthLayer('l1')
export class ApprovalsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string, @Query('state') state?: string): Promise<{ approvals: Array<Record<string, unknown>> }> {
    return { approvals: await this.conversations.listApprovals({ orgId, state }) };
  }

  @Post(':approvalId/extend')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async extend(
    @Param('orgId') orgId: string,
    @Param('approvalId') approvalId: string,
    @Body() dto: { expires_at?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ approval: Record<string, unknown> }> {
    if (typeof dto.expires_at !== 'string') {
      throw ApiError.validation({ expires_at: 'is required (future ISO timestamp)' });
    }
    return { approval: await this.conversations.extendApproval({ orgId, approvalId, expiresAt: dto.expires_at, actor: principal.id }) };
  }
}
