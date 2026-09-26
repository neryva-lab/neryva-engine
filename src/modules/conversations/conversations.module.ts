import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { EscalationsService } from './escalations.service';
import { McpAuthorityService } from './mcp-authority.service';
import { ConversationsController, RunsController } from './conversations.controller';
import { ApprovalsController } from './approvals.controller';
import { ConversationsPublicController } from './conversations.public.controller';
import { PublicSharesController } from './conversations.public-shares.controller';
import { EscalationsController } from './escalations.controller';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BillingModule } from '../billing/billing.module';
import { env } from '../../common/config/env';
import { DbService } from '../../common/infra/db/db.service';
import { MongoDbService } from '../../common/infra/db/mongo/mongo.service';
import {
  APPROVAL_REPOSITORY,
  ARTIFACT_REPOSITORY,
  CHECKPOINT_REPOSITORY,
  CONVERSATION_REPOSITORY,
  ESCALATION_REPOSITORY,
  FEEDBACK_REPOSITORY,
  MEMORY_REPOSITORY,
  RUN_CONTEXT_REPOSITORY,
  RUN_EVENTS_REPOSITORY,
  RUN_LEASE_REPOSITORY,
  RUN_REPOSITORY,
  RUN_TERMINAL_REPOSITORY,
  SHARE_REPOSITORY,
  TOOL_AUTHORITY_REPOSITORY,
} from './repositories/repository-tokens';
import { PgConversationRepository } from './repositories/pg-conversation.repository';
import { MongoConversationRepository } from './repositories/mongo-conversation.repository';
import { PgRunRepository } from './repositories/pg-run.repository';
import { MongoRunRepository } from './repositories/mongo-run.repository';
import { PgShareRepository } from './repositories/pg-share.repository';
import { MongoShareRepository } from './repositories/mongo-share.repository';
import { PgFeedbackRepository } from './repositories/pg-feedback.repository';
import { MongoFeedbackRepository } from './repositories/mongo-feedback.repository';
import { PgEscalationRepository } from './repositories/pg-escalation.repository';
import { MongoEscalationRepository } from './repositories/mongo-escalation.repository';
import { PgRunLeaseRepository } from './repositories/pg-run-lease.repository';
import { MongoRunLeaseRepository } from './repositories/mongo-run-lease.repository';
import { PgRunEventsRepository } from './repositories/pg-run-events.repository';
import { MongoRunEventsRepository } from './repositories/mongo-run-events.repository';
import { PgApprovalRepository } from './repositories/pg-approval.repository';
import { MongoApprovalRepository } from './repositories/mongo-approval.repository';
import { PgToolAuthorityRepository } from './repositories/pg-tool-authority.repository';
import { MongoToolAuthorityRepository } from './repositories/mongo-tool-authority.repository';
import { PgCheckpointRepository } from './repositories/pg-checkpoint.repository';
import { MongoCheckpointRepository } from './repositories/mongo-checkpoint.repository';
import { PgArtifactRepository } from './repositories/pg-artifact.repository';
import { MongoArtifactRepository } from './repositories/mongo-artifact.repository';
import { PgRunContextRepository } from './repositories/pg-run-context.repository';
import { MongoRunContextRepository } from './repositories/mongo-run-context.repository';
import { PgMemoryRepository } from './repositories/pg-memory.repository';
import { MongoMemoryRepository } from './repositories/mongo-memory.repository';
import { PgRunTerminalRepository } from './repositories/pg-run-terminal.repository';
import { MongoRunTerminalRepository } from './repositories/mongo-run-terminal.repository';

/**
 * Provider selection for the conversations persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 */
function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

@Module({
  // KnowledgeModule (RetrievalService) + BillingModule (UsageLedgerService)
  // satisfy McpAuthorityService's constructor; neither cone imports this
  // module, so no cycle. McpAuthorityService lives HERE (not in McpModule)
  // because RunsController needs it in this module's context.
  imports: [LifecycleModule, OrganizationsModule, KnowledgeModule, BillingModule],
  controllers: [ConversationsController, RunsController, EscalationsController, ConversationsPublicController, PublicSharesController, ApprovalsController],
  providers: [
    ConversationsService,
    EscalationsService,
    McpAuthorityService,
    repositoryProvider(
      CONVERSATION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoConversationRepository(mongo) : new PgConversationRepository(db)),
    ),
    repositoryProvider(
      RUN_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRunRepository(mongo) : new PgRunRepository(db)),
    ),
    repositoryProvider(
      SHARE_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoShareRepository(mongo) : new PgShareRepository(db)),
    ),
    repositoryProvider(
      FEEDBACK_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoFeedbackRepository(mongo) : new PgFeedbackRepository(db)),
    ),
    repositoryProvider(
      ESCALATION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoEscalationRepository(mongo) : new PgEscalationRepository(db)),
    ),
    repositoryProvider(
      RUN_LEASE_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRunLeaseRepository(mongo) : new PgRunLeaseRepository(db)),
    ),
    repositoryProvider(
      RUN_EVENTS_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRunEventsRepository(mongo) : new PgRunEventsRepository(db)),
    ),
    repositoryProvider(
      APPROVAL_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoApprovalRepository(mongo) : new PgApprovalRepository(db)),
    ),
    repositoryProvider(
      TOOL_AUTHORITY_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoToolAuthorityRepository(mongo) : new PgToolAuthorityRepository(db)),
    ),
    repositoryProvider(
      CHECKPOINT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoCheckpointRepository(mongo) : new PgCheckpointRepository(db)),
    ),
    repositoryProvider(
      ARTIFACT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoArtifactRepository(mongo) : new PgArtifactRepository(db)),
    ),
    repositoryProvider(
      RUN_CONTEXT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRunContextRepository(mongo) : new PgRunContextRepository(db)),
    ),
    repositoryProvider(
      MEMORY_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoMemoryRepository(mongo) : new PgMemoryRepository(db)),
    ),
    repositoryProvider(
      RUN_TERMINAL_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRunTerminalRepository(mongo) : new PgRunTerminalRepository(db)),
    ),
  ],
  exports: [ConversationsService, EscalationsService, McpAuthorityService],
})
export class ConversationsModule {}
