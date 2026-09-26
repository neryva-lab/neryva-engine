import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  CONFIG_DRAFT_REPOSITORY,
  CONFIG_NOTIFICATION_REPOSITORY,
  CONFIG_PUBLISH_REPOSITORY,
} from './repository-tokens';
import { PgConfigPublishRepository } from './pg-config-publish.repository';
import { MongoConfigPublishRepository } from './mongo-config-publish.repository';
import { PgConfigDraftRepository } from './pg-config-draft.repository';
import { MongoConfigDraftRepository } from './mongo-config-draft.repository';
import { PgConfigNotificationRepository } from './pg-config-notification.repository';
import { MongoConfigNotificationRepository } from './mongo-config-notification.repository';

/**
 * Provider selection for the config-publish persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * This module exists separately from `ConfigPublishModule` so that future
 * consumers can inject the persistence ports without importing the full
 * module (and its satellite/console wiring) — the same precedent as the
 * assistants `AssistantRepositoriesModule`.
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

const REPOSITORY_PROVIDERS = [
  repositoryProvider(
    CONFIG_PUBLISH_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoConfigPublishRepository(mongo) : new PgConfigPublishRepository(db),
  ),
  repositoryProvider(
    CONFIG_DRAFT_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoConfigDraftRepository(mongo) : new PgConfigDraftRepository(db),
  ),
  repositoryProvider(
    CONFIG_NOTIFICATION_REPOSITORY,
    (db, mongo) =>
      isMongo()
        ? new MongoConfigNotificationRepository(mongo)
        : new PgConfigNotificationRepository(db),
  ),
];

const REPOSITORY_TOKENS = [
  CONFIG_PUBLISH_REPOSITORY,
  CONFIG_DRAFT_REPOSITORY,
  CONFIG_NOTIFICATION_REPOSITORY,
];

@Module({
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_TOKENS],
})
export class ConfigPublishRepositoriesModule {}
