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
import { ProviderCredentialsService } from './provider-credentials.service';
import { ProviderCredentialsController } from './provider-credentials.controller';
import { ProviderPlaneStaffController } from './provider-plane.staff.controller';
import { ModelCatalogService } from './model-catalog.service';
import { ModelCatalogController } from './model-catalog.controller';
import { ModelCostService } from './model-cost.service';
import { FleetStaffController } from './fleet.staff.controller';
import { BurnRateService } from './burn-rate.service';
import { ConfigPublishModule } from '../config-publish/config-publish.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ConversationsModule } from '../conversations/conversations.module';

@Module({
  // ConversationsModule (ConversationsService) backs the REL-2.4 test-run
  // endpoint; the conversations cone does not import this module, so no cycle.
  imports: [ConfigPublishModule, KnowledgeModule, OrganizationsModule, ConversationsModule],
  controllers: [
    AssistantsController,
    TemplatesController,
    ToolCatalogController,
    RolloutsController,
    ReleasesController,
    ControlBlocksController,
    ProviderCredentialsController,
    ModelCatalogController,
    ProviderPlaneStaffController,
    FleetStaffController,
  ],
  providers: [
    AssistantsService,
    TemplatesService,
    ManifestResolutionService,
    ControlBlocksService,
    ToolCatalogService,
    RolloutsService,
    ProviderCredentialsService,
    ModelCatalogService,
    ModelCostService,
    BurnRateService,
  ],
  exports: [AssistantsService, TemplatesService, ToolCatalogService, ControlBlocksService, BurnRateService],
})
export class AssistantsModule {}
