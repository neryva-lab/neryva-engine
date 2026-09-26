import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  DEPLOYMENT_PIPELINE_REPOSITORY,
  DEPLOYMENT_ENVIRONMENT_REPOSITORY,
  DEPLOYMENT_RUN_REPOSITORY,
  DEPLOYMENT_SECRET_REPOSITORY,
  DEPLOYMENT_SETTINGS_REPOSITORY,
} from './repository-tokens';
import { PgDeploymentPipelineRepository } from './pg-pipeline.repository';
import { MongoDeploymentPipelineRepository } from './mongo-pipeline.repository';
import { PgDeploymentEnvironmentRepository } from './pg-environment.repository';
import { MongoDeploymentEnvironmentRepository } from './mongo-environment.repository';
import { PgDeploymentRunRepository } from './pg-deployment.repository';
import { MongoDeploymentRunRepository } from './mongo-deployment.repository';
import { PgDeploymentSecretRepository } from './pg-secret.repository';
import { MongoDeploymentSecretRepository } from './mongo-secret.repository';
import { PgDeploymentSettingsRepository } from './pg-settings.repository';
import { MongoDeploymentSettingsRepository } from './mongo-settings.repository';

/**
 * Provider selection for the deployment persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * This module was missing entirely — `PipelinesService` injected the
 * repository tokens but nothing provided them, so the application crashed
 * at startup whenever the deployment module was enabled.
 */
function repositoryProvider(token: symbol, create: (db: DbService, mongo: MongoDbService) => unknown) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

const REPOSITORY_PROVIDERS = [
  repositoryProvider(
    DEPLOYMENT_PIPELINE_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoDeploymentPipelineRepository(mongo) : new PgDeploymentPipelineRepository(db),
  ),
  repositoryProvider(
    DEPLOYMENT_ENVIRONMENT_REPOSITORY,
    (db, mongo) =>
      isMongo()
        ? new MongoDeploymentEnvironmentRepository(mongo)
        : new PgDeploymentEnvironmentRepository(db),
  ),
  repositoryProvider(
    DEPLOYMENT_RUN_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoDeploymentRunRepository(mongo) : new PgDeploymentRunRepository(db),
  ),
  repositoryProvider(
    DEPLOYMENT_SECRET_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoDeploymentSecretRepository(mongo) : new PgDeploymentSecretRepository(db),
  ),
  repositoryProvider(
    DEPLOYMENT_SETTINGS_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoDeploymentSettingsRepository(mongo) : new PgDeploymentSettingsRepository(db),
  ),
];

const REPOSITORY_TOKENS = [
  DEPLOYMENT_PIPELINE_REPOSITORY,
  DEPLOYMENT_ENVIRONMENT_REPOSITORY,
  DEPLOYMENT_RUN_REPOSITORY,
  DEPLOYMENT_SECRET_REPOSITORY,
  DEPLOYMENT_SETTINGS_REPOSITORY,
];

@Module({
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_TOKENS],
})
export class DeploymentRepositoriesModule {}
