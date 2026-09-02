import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { AssistantsService } from './assistants.service';
import { CreateAssistantDto, CreateVersionDto, ImportVersionDto, RollbackDto } from './dto';

@Controller('console/org/:orgId/assistants')
@AuthLayer('l1')
export class AssistantsController {
  constructor(private readonly assistants: AssistantsService) {}

  @Post()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async create(@Param('orgId') orgId: string, @Body() dto: CreateAssistantDto, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.assistants.create({ orgId, name: dto.name, description: dto.description ?? null, createdBy: principal.id });
    return { assistant: row };
  }

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string) {
    const rows = await this.assistants.list(orgId);
    return { assistants: rows };
  }

  @Get(':assistantId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string) {
    const row = await this.assistants.get(orgId, assistantId);
    if (!row) {
      return { error: 'not found' };
    }
    return { assistant: row };
  }

  @Post(':assistantId/versions')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createVersion(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: CreateVersionDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.createVersion({
      orgId,
      assistantId,
      payload: dto as unknown as import('./validation').AssistantPayload,
      createdBy: principal.id,
    });
    return { version: row };
  }

  @Get(':assistantId/versions')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listVersions(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string) {
    const rows = await this.assistants.listVersions(orgId, assistantId);
    return { versions: rows };
  }

  @Post(':assistantId/versions/:versionId/publish')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async publish(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.publish({ orgId, assistantId, versionId, publishedBy: principal.id });
    return { version: row };
  }

  @Post(':assistantId/rollback')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async rollback(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: RollbackDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.rollback({ orgId, assistantId, toVersionId: dto.to_version_id, publishedBy: principal.id });
    return { version: row };
  }

  @Get(':assistantId/versions/:versionId/export')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async exportVersion(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
  ) {
    const envelope = await this.assistants.exportVersion(orgId, versionId);
    return { export: envelope };
  }

  @Post(':assistantId/versions/import')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async importVersion(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: ImportVersionDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.importVersion({
      orgId,
      assistantId,
      exported: dto as unknown as import('./schema').AssistantVersionExport,
      createdBy: principal.id,
    });
    return { version: row };
  }

  @Get(':assistantId/versions/:versionId/snapshot')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async getSnapshot(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
  ) {
    const snapshot = await this.assistants.getSnapshotForVersion(orgId, assistantId, versionId);
    if (!snapshot) {
      return { error: 'not found' };
    }
    return { snapshot };
  }
}
