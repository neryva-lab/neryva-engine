import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { WEBHOOK_DELIVERY_REPOSITORY, WEBHOOK_REPOSITORY } from './repository-tokens';
import { PgWebhookRepository } from './pg-webhook.repository';
import { MongoWebhookRepository } from './mongo-webhook.repository';
import { PgWebhookDeliveryRepository } from './pg-webhook-delivery.repository';
import { MongoWebhookDeliveryRepository } from './mongo-webhook-delivery.repository';

/**
 * Provider selection for the webhooks persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * This module exists separately from `WebhooksModule` so that other
 * consumers (e.g. workers) can inject the webhooks persistence ports WITHOUT
 * importing `WebhooksModule` — which would be a module cycle, since the
 * lifecycle consumer lives there.
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
    WEBHOOK_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoWebhookRepository(mongo) : new PgWebhookRepository(db)),
  ),
  repositoryProvider(
    WEBHOOK_DELIVERY_REPOSITORY,
    (db, mongo) =>
      isMongo() ? new MongoWebhookDeliveryRepository(mongo) : new PgWebhookDeliveryRepository(db),
  ),
];

const REPOSITORY_TOKENS = [WEBHOOK_REPOSITORY, WEBHOOK_DELIVERY_REPOSITORY];

@Module({
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_TOKENS],
})
export class WebhooksRepositoriesModule {}
