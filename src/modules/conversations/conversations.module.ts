import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { EscalationsService } from './escalations.service';
import { McpAuthorityService } from './mcp-authority.service';
import { ConversationsController, RunsController } from './conversations.controller';
import { ConversationsPublicController } from './conversations.public.controller';
import { PublicSharesController } from './conversations.public-shares.controller';
import { EscalationsController } from './escalations.controller';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  // KnowledgeModule (RetrievalService) + BillingModule (UsageLedgerService)
  // satisfy McpAuthorityService's constructor; neither cone imports this
  // module, so no cycle. McpAuthorityService lives HERE (not in McpModule)
  // because RunsController needs it in this module's context.
  imports: [LifecycleModule, OrganizationsModule, KnowledgeModule, BillingModule],
  controllers: [ConversationsController, RunsController, EscalationsController, ConversationsPublicController, PublicSharesController],
  providers: [ConversationsService, EscalationsService, McpAuthorityService],
  exports: [ConversationsService, EscalationsService, McpAuthorityService],
})
export class ConversationsModule {}
