import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  API_KEY_REPOSITORY,
  STUDIO_PROJECT_KEY_REPOSITORY,
} from './repository-tokens';
import { PgApiKeyRepository } from './pg-api-key.repository';
import { MongoApiKeyRepository } from './mongo-api-key.repository';
import { PgStudioProjectKeyRepository } from './pg-studio-project-key.repository';
import { MongoStudioProjectKeyRepository } from './mongo-studio-project-key.repository';

/**
 * Provider selection for the keys persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * This module exists separately from `KeysModule` so that other modules
 * can inject the keys persistence ports WITHOUT importing `KeysModule` —
 * which would be a module cycle risk (e.g. the L2 auth guard plane, which
 * must validate `nrv_live_` keys without the console CRUD surface).
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
    API_KEY_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoApiKeyRepository(mongo) : new PgApiKeyRepository(db)),
  ),
  repositoryProvider(
    STUDIO_PROJECT_KEY_REPOSITORY,
    (db, mongo) =>
      isMongo()
        ? new MongoStudioProjectKeyRepository(mongo)
        : new PgStudioProjectKeyRepository(db),
  ),
];

const REPOSITORY_TOKENS = [API_KEY_REPOSITORY, STUDIO_PROJECT_KEY_REPOSITORY];

@Module({
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_TOKENS],
})
export class KeysRepositoriesModule {}
