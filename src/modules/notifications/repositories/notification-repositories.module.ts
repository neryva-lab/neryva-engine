import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { NOTIFICATION_REPOSITORY } from './repository-tokens';
import { PgNotificationRepository } from './pg-notification.repository';
import { MongoNotificationRepository } from './mongo-notification.repository';

/**
 * Provider selection for the notifications persistence ports (P3).
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
  providers: [
    repositoryProvider(
      NOTIFICATION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoNotificationRepository(mongo) : new PgNotificationRepository(db)),
    ),
  ],
  exports: [NOTIFICATION_REPOSITORY],
})
export class NotificationRepositoriesModule {}
