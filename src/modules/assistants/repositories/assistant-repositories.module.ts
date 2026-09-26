import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { ConfigPublishModule } from '../../config-publish/config-publish.module';
import { ConfigPublishService } from '../../config-publish/config-publish.service';
import {
  ASSISTANT_REPOSITORY,
  ASSISTANT_VERSION_REPOSITORY,
  POLICY_SNAPSHOT_REPOSITORY,
  TEMPLATE_REPOSITORY,
  TOOL_CATALOG_REPOSITORY,
  CONTROL_BLOCK_REPOSITORY,
  ROLLOUT_REPOSITORY,
  BURN_RATE_REPOSITORY,
  MODEL_CATALOG_REPOSITORY,
  MODEL_COST_REPOSITORY,
  PROVIDER_CREDENTIAL_REPOSITORY,
  FLEET_STAFF_REPOSITORY,
} from './repository-tokens';
import { ASSISTANT_KNOWLEDGE_QUERIES } from './tokens';
import { PgAssistantRepository } from './pg-assistant.repository';
import { MongoAssistantRepository } from './mongo-assistant.repository';
import { PgAssistantVersionRepository } from './pg-assistant-version.repository';
import { MongoAssistantVersionRepository } from './mongo-assistant-version.repository';
import { PgPolicySnapshotRepository } from './pg-policy-snapshot.repository';
import { MongoPolicySnapshotRepository } from './mongo-policy-snapshot.repository';
import { PgTemplateRepository } from './pg-template.repository';
import { MongoTemplateRepository } from './mongo-template.repository';
import { PgToolCatalogRepository } from './pg-tool-catalog.repository';
import { MongoToolCatalogRepository } from './mongo-tool-catalog.repository';
import { PgControlBlockRepository } from './pg-control-block.repository';
import { MongoControlBlockRepository } from './mongo-control-block.repository';
import { PgRolloutRepository } from './pg-rollout.repository';
import { MongoRolloutRepository } from './mongo-rollout.repository';
import { PgBurnRateRepository } from './pg-burn-rate.repository';
import { MongoBurnRateRepository } from './mongo-burn-rate.repository';
import { PgModelCatalogRepository } from './pg-model-catalog.repository';
import { MongoModelCatalogRepository } from './mongo-model-catalog.repository';
import { PgModelCostRepository } from './pg-model-cost.repository';
import { MongoModelCostRepository } from './mongo-model-cost.repository';
import { PgProviderCredentialRepository } from './pg-provider-credential.repository';
import { MongoProviderCredentialRepository } from './mongo-provider-credential.repository';
import { PgFleetStaffRepository } from './pg-fleet-staff.repository';
import { MongoFleetStaffRepository } from './mongo-fleet-staff.repository';
import { PgAssistantKnowledgeQueries } from './pg-assistant-knowledge.queries';
import { MongoAssistantKnowledgeQueries } from './mongo-assistant-knowledge.queries';

/**
 * Provider selection for the assistants persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * Two ports (version, policy-snapshot) additionally receive
 * `ConfigPublishService` — manifest resolution reads the latest config
 * through it (own read transaction, by design). Every other port needs
 * only the database services.
 *
 * This module exists separately from `AssistantsModule` so that other
 * modules (e.g. knowledge's `EvalService`) can inject the assistants
 * persistence ports WITHOUT importing `AssistantsModule` — which would be
 * a module cycle, since `AssistantsModule` imports `KnowledgeModule`.
 */
function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService, configPublish: ConfigPublishService) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService, ConfigPublishService],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

const REPOSITORY_PROVIDERS = [
  repositoryProvider(
    ASSISTANT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoAssistantRepository(mongo) : new PgAssistantRepository(db)),
  ),
  repositoryProvider(
    ASSISTANT_VERSION_REPOSITORY,
    (db, mongo, configPublish) =>
      isMongo()
        ? new MongoAssistantVersionRepository(mongo)
        : new PgAssistantVersionRepository(db, configPublish),
  ),
  repositoryProvider(
    POLICY_SNAPSHOT_REPOSITORY,
    (db, mongo, configPublish) =>
      isMongo()
        ? new MongoPolicySnapshotRepository(mongo)
        : new PgPolicySnapshotRepository(db, configPublish),
  ),
  repositoryProvider(
    TEMPLATE_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoTemplateRepository(mongo) : new PgTemplateRepository(db)),
  ),
  repositoryProvider(
    TOOL_CATALOG_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoToolCatalogRepository(mongo) : new PgToolCatalogRepository(db)),
  ),
  repositoryProvider(
    CONTROL_BLOCK_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoControlBlockRepository(mongo) : new PgControlBlockRepository(db)),
  ),
  repositoryProvider(
    ROLLOUT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoRolloutRepository(mongo) : new PgRolloutRepository(db)),
  ),
  repositoryProvider(
    BURN_RATE_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoBurnRateRepository(mongo) : new PgBurnRateRepository(db)),
  ),
  repositoryProvider(
    MODEL_CATALOG_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoModelCatalogRepository(mongo) : new PgModelCatalogRepository(db)),
  ),
  repositoryProvider(
    MODEL_COST_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoModelCostRepository(mongo) : new PgModelCostRepository(db)),
  ),
  repositoryProvider(
    PROVIDER_CREDENTIAL_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoProviderCredentialRepository(mongo) : new PgProviderCredentialRepository(db)),
  ),
  repositoryProvider(
    FLEET_STAFF_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoFleetStaffRepository(mongo) : new PgFleetStaffRepository(db)),
  ),
  repositoryProvider(
    ASSISTANT_KNOWLEDGE_QUERIES,
    (db, mongo) =>
      isMongo()
        ? new MongoAssistantKnowledgeQueries(mongo)
        : new PgAssistantKnowledgeQueries(db),
  ),
];

const REPOSITORY_TOKENS = [
  ASSISTANT_REPOSITORY,
  ASSISTANT_VERSION_REPOSITORY,
  POLICY_SNAPSHOT_REPOSITORY,
  TEMPLATE_REPOSITORY,
  TOOL_CATALOG_REPOSITORY,
  CONTROL_BLOCK_REPOSITORY,
  ROLLOUT_REPOSITORY,
  BURN_RATE_REPOSITORY,
  MODEL_CATALOG_REPOSITORY,
  MODEL_COST_REPOSITORY,
  PROVIDER_CREDENTIAL_REPOSITORY,
  FLEET_STAFF_REPOSITORY,
  ASSISTANT_KNOWLEDGE_QUERIES,
];

@Module({
  imports: [ConfigPublishModule],
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_TOKENS],
})
export class AssistantRepositoriesModule {}
