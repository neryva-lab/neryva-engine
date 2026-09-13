import { Module } from '@nestjs/common';
import { AssistantsService } from './assistants.service';
import { AssistantsController } from './assistants.controller';
import { ToolCatalogService } from './tool-catalog.service';
import { ToolCatalogController } from './tool-catalog.controller';
import { RolloutsService } from './rollouts.service';
import { RolloutsController } from './rollouts.controller';
import { ConfigPublishModule } from '../config-publish/config-publish.module';

@Module({
  imports: [ConfigPublishModule],
  controllers: [AssistantsController, ToolCatalogController, RolloutsController],
  providers: [AssistantsService, ToolCatalogService, RolloutsService],
  exports: [AssistantsService, ToolCatalogService],
})
export class AssistantsModule {}
