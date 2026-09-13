import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthLayer } from '../../common/auth/decorators';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { ApiError } from '../../common/http/api-error';
import { TemplatesService } from './templates.service';

/**
 * Template registry reads — TPL-1.4 (consumer contract §7.3 items 1-2).
 *
 * System API only: any consumer (console, CLI, integration) builds on
 * these endpoints after the system lands. No consumer implementation here.
 */
@Controller('console/org/:orgId/assistant-templates')
@AuthLayer('l1')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string) {
    const templates = await this.templates.list(orgId);
    return { templates };
  }

  @Get(':slug')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('slug') slug: string, @Query('version') version?: string) {
    void orgId;
    const template = await this.templates.get(slug, version);
    if (!template) {
      throw ApiError.notFound('assistant template');
    }
    return { template };
  }
}
