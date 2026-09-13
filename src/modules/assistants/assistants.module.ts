import { Module } from '@nestjs/common';
import { AssistantsService } from './assistants.service';
import { AssistantsController } from './assistants.controller';
import { TemplatesService } from './templates.service';
import { TemplatesController } from './templates.controller';
import { ManifestResolutionService } from './manifest-resolution.service';
import { ControlBlocksService } from './control-blocks.service';
import { ControlBlocksController } from './control-blocks.controller';
import { ToolCatalogService } from './tool-catalog.service';
import { ToolCatalogController } from './tool-catalog.controller';
import { RolloutsService } from './rollouts.service';
import { RolloutsController } from './rollouts.controller';
import { ReleasesController } from './releases.controller';
import { ConfigPublishModule } from '../config-publish/config-publish.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [ConfigPublishModule, KnowledgeModule, OrganizationsModule],
  controllers: [AssistantsController, TemplatesController, ToolCatalogController, RolloutsController, ReleasesController, ControlBlocksController],
  providers: [AssistantsService, TemplatesService, ManifestResolutionService, ControlBlocksService, ToolCatalogService, RolloutsService],
  exports: [AssistantsService, TemplatesService, ToolCatalogService, ControlBlocksService],
})
export class AssistantsModule {}
