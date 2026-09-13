import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { ChannelTemplatesService } from './templates.service';

/**
 * FL-3.18 — template management surface (console). The management UI is a
 * consumer concern; these routes are its API.
 */
@Controller('console/org/:orgId/channels/:channelId/templates')
@AuthLayer('l1')
export class ChannelTemplatesController {
  constructor(private readonly templates: ChannelTemplatesService) {}

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string, @Param('channelId') channelId: string) {
    return { templates: await this.templates.list(orgId, channelId) };
  }

  @Post()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async create(
    @Param('orgId') orgId: string,
    @Param('channelId') channelId: string,
    @Body() dto: { name?: unknown; language?: unknown; body_text?: unknown; variables?: unknown; provider_template_id?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (typeof dto.name !== 'string') {
      throw ApiError.validation({ name: 'must be a string' });
    }
    if (typeof dto.body_text !== 'string') {
      throw ApiError.validation({ body_text: 'must be a string' });
    }
    if (dto.variables !== undefined && (!Array.isArray(dto.variables) || !dto.variables.every((v) => typeof v === 'string'))) {
      throw ApiError.validation({ variables: 'must be an array of strings' });
    }
    const template = await this.templates.create({
      orgId,
      accountId: channelId,
      name: dto.name,
      language: typeof dto.language === 'string' ? dto.language : 'en',
      bodyText: dto.body_text,
      variables: dto.variables as string[] | undefined,
      providerTemplateId: typeof dto.provider_template_id === 'string' ? dto.provider_template_id : undefined,
      actor: principal.id,
    });
    return { template };
  }

  @Post(':templateId/status')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async setStatus(
    @Param('orgId') orgId: string,
    @Param('channelId') channelId: string,
    @Param('templateId') templateId: string,
    @Body() dto: { status?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    void channelId;
    const allowed = ['draft', 'approved', 'rejected', 'archived'] as const;
    if (typeof dto.status !== 'string' || !(allowed as readonly string[]).includes(dto.status)) {
      throw ApiError.validation({ status: `must be one of ${allowed.join(', ')}` });
    }
    const template = await this.templates.setStatus({
      orgId,
      templateId,
      status: dto.status as 'draft' | 'approved' | 'rejected' | 'archived',
      actor: principal.id,
    });
    return { template };
  }
}
