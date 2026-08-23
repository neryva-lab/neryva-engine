import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { OrgGroupsService } from './org-groups.service';

export class CreateGroupDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}

export class GroupMemberDto {
  @IsString()
  @Length(36, 36)
  account_id!: string;
}

/**
 * Groups (eng-0009): named membership collections for finer-grained access
 * control. Every role views; owner/admin manages. Group membership never
 * bypasses the role matrix — it is additive context for products that map
 * groups to their own capability grants.
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgGroupsController {
  constructor(private readonly groups: OrgGroupsService) {}

  @Get(':orgId/groups')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async listGroups(@Param('orgId') orgId: string): Promise<{ groups: unknown[] }> {
    return { groups: await this.groups.list(orgId) };
  }

  @Get(':orgId/groups/:groupId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async getGroup(@Param('orgId') orgId: string, @Param('groupId') groupId: string): Promise<{ group: unknown }> {
    return { group: await this.groups.get(orgId, groupId) };
  }

  @Post(':orgId/groups')
  @Roles('owner', 'admin')
  @Idempotent()
  async createGroup(
    @Param('orgId') orgId: string,
    @Body() dto: CreateGroupDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ group: unknown }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    return { group: await this.groups.create({ orgId, name: dto.name, description: dto.description, actorId: principal.id }) };
  }

  @Patch(':orgId/groups/:groupId')
  @Roles('owner', 'admin')
  async updateGroup(
    @Param('orgId') orgId: string,
    @Param('groupId') groupId: string,
    @Body() dto: UpdateGroupDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.groups.update({ orgId, groupId, ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), actorId: principal.id });
    return { ok: true };
  }

  @Delete(':orgId/groups/:groupId')
  @Roles('owner', 'admin')
  async deleteGroup(
    @Param('orgId') orgId: string,
    @Param('groupId') groupId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.groups.remove({ orgId, groupId, actorId: principal.id });
    return { ok: true };
  }

  @Get(':orgId/groups/:groupId/members')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async listGroupMembers(@Param('orgId') orgId: string, @Param('groupId') groupId: string): Promise<{ members: unknown[] }> {
    return { members: await this.groups.listMembers(orgId, groupId) };
  }

  @Post(':orgId/groups/:groupId/members')
  @Roles('owner', 'admin')
  @Idempotent()
  async addGroupMember(
    @Param('orgId') orgId: string,
    @Param('groupId') groupId: string,
    @Body() dto: GroupMemberDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.groups.addMember({ orgId, groupId, accountId: dto.account_id, actorId: principal.id });
    return { ok: true };
  }

  @Delete(':orgId/groups/:groupId/members/:accountId')
  @Roles('owner', 'admin')
  async removeGroupMember(
    @Param('orgId') orgId: string,
    @Param('groupId') groupId: string,
    @Param('accountId') accountId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.groups.removeMember({ orgId, groupId, accountId, actorId: principal.id });
    return { ok: true };
  }
}
