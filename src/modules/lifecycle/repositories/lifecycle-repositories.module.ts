import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  LEGAL_HOLD_REPOSITORY,
  EXPORT_REPOSITORY,
  DATA_ACCESS_REPOSITORY,
  RETENTION_POLICY_REPOSITORY,
  PURGE_TASK_REPOSITORY,
  PURGE_STEP_REPOSITORY,
} from './repository-tokens';
import { PgLegalHoldRepository } from './pg-legal-hold.repository';
import { MongoLegalHoldRepository } from './mongo-legal-hold.repository';
import { PgExportRepository } from './pg-export.repository';
import { MongoExportRepository } from './mongo-export.repository';
import { PgDataAccessRepository } from './pg-data-access.repository';
import { MongoDataAccessRepository } from './mongo-data-access.repository';
import { PgRetentionPolicyRepository } from './pg-retention-policy.repository';
import { MongoRetentionPolicyRepository } from './mongo-retention-policy.repository';
import { PgPurgeTaskRepository } from './pg-purge-task.repository';
import { MongoPurgeTaskRepository } from './mongo-purge-task.repository';
import { PgPurgeStepRepository } from './pg-purge-step.repository';
import { MongoPurgeStepRepository } from './mongo-purge-step.repository';

/**
 * Provider selection for the lifecycle persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * This module was missing entirely — the six repository pairs existed but
 * nothing provided their tokens, and `RetentionPurgeService` still used
 * `DbService` (PostgreSQL) directly.
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
    LEGAL_HOLD_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoLegalHoldRepository(mongo) : new PgLegalHoldRepository(db)),
  ),
  repositoryProvider(
    EXPORT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoExportRepository(mongo) : new PgExportRepository(db)),
  ),
  repositoryProvider(
    DATA_ACCESS_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoDataAccessRepository(mongo) : new PgDataAccessRepository(db)),
  ),
  repositoryProvider(
    RETENTION_POLICY_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoRetentionPolicyRepository(mongo) : new PgRetentionPolicyRepository(db),
  ),
  repositoryProvider(
    PURGE_TASK_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoPurgeTaskRepository(mongo) : new PgPurgeTaskRepository(db)),
  ),
  repositoryProvider(
    PURGE_STEP_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoPurgeStepRepository(mongo) : new PgPurgeStepRepository(db)),
  ),
];

const REPOSITORY_TOKENS = [
  LEGAL_HOLD_REPOSITORY,
  EXPORT_REPOSITORY,
  DATA_ACCESS_REPOSITORY,
  RETENTION_POLICY_REPOSITORY,
  PURGE_TASK_REPOSITORY,
  PURGE_STEP_REPOSITORY,
];

@Module({
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_TOKENS],
})
export class LifecycleRepositoriesModule {}
