import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { ProjectsService } from './projects.service';

export class CreateProjectDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}

/**
 * Projects (Δ2): key/limit/usage containers under the org. Every role
 * views; owner/admin/developer manage. Archived projects stay readable via
 * ?include_archived=true (the export/unarchive flows need them).
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get(':orgId/projects')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async listProjects(@Param('orgId') orgId: string, @Query('include_archived') includeArchived?: string): Promise<{ projects: unknown[] }> {
    return { projects: await this.projects.list(orgId, includeArchived === 'true' || includeArchived === '1') };
  }

  @Get(':orgId/projects/:projectId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async getProject(@Param('orgId') orgId: string, @Param('projectId') projectId: string): Promise<{ project: unknown }> {
    return { project: await this.projects.get(orgId, projectId) };
  }

  @Post(':orgId/projects')
  @Roles('owner', 'admin', 'developer')
  @Idempotent()
  async createProject(
    @Param('orgId') orgId: string,
    @Body() dto: CreateProjectDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ project: unknown }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    return { project: await this.projects.create({ orgId, name: dto.name, description: dto.description, actorId: principal.id }) };
  }

  @Patch(':orgId/projects/:projectId')
  @Roles('owner', 'admin', 'developer')
  async updateProject(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ project: unknown }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    return { project: await this.projects.update({ orgId, projectId, ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), actorId: principal.id }) };
  }

  @Post(':orgId/projects/:projectId/archive')
  @Roles('owner', 'admin', 'developer')
  async archiveProject(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.projects.archive({ orgId, projectId, actorId: principal.id });
    return { ok: true };
  }

  @Post(':orgId/projects/:projectId/unarchive')
  @Roles('owner', 'admin', 'developer')
  async unarchiveProject(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.projects.unarchive({ orgId, projectId, actorId: principal.id });
    return { ok: true };
  }
}
