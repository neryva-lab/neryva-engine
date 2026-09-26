/**
 * Provider selection for the corporate persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * Corporate tables/collections are global (non-tenant, no organization_id,
 * no RLS): every repository method is one `withBypass` unit.
 */
import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  CAREERS_REPOSITORY,
  CONTACT_INBOX_REPOSITORY,
  CONTENT_REPOSITORY,
  CONTENT_STAFF_REPOSITORY,
  EMAIL_DELIVERY_REPOSITORY,
  NEWSLETTER_REPOSITORY,
  SUPPRESSION_REPOSITORY,
} from './repository-tokens';
import { PgCareersRepository } from './pg-careers.repository';
import { MongoCareersRepository } from './mongo-careers.repository';
import { PgContactInboxRepository } from './pg-contact-inbox.repository';
import { MongoContactInboxRepository } from './mongo-contact-inbox.repository';
import { PgContentRepository } from './pg-content.repository';
import { MongoContentRepository } from './mongo-content.repository';
import { PgNewsletterRepository } from './pg-newsletter.repository';
import { MongoNewsletterRepository } from './mongo-newsletter.repository';
import { PgSuppressionRepository } from './pg-suppression.repository';
import { MongoSuppressionRepository } from './mongo-suppression.repository';
import { PgEmailDeliveryRepository } from './pg-email-delivery.repository';
import { MongoEmailDeliveryRepository } from './mongo-email-delivery.repository';
import { PgContentStaffRepository } from './pg-content-staff.repository';
import { MongoContentStaffRepository } from './mongo-content-staff.repository';

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

const providers = [
  repositoryProvider(CAREERS_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoCareersRepository(mongo) : new PgCareersRepository(db),
  ),
  repositoryProvider(CONTACT_INBOX_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoContactInboxRepository(mongo) : new PgContactInboxRepository(db),
  ),
  repositoryProvider(CONTENT_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoContentRepository(mongo) : new PgContentRepository(db),
  ),
  repositoryProvider(NEWSLETTER_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoNewsletterRepository(mongo) : new PgNewsletterRepository(db),
  ),
  repositoryProvider(SUPPRESSION_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoSuppressionRepository(mongo) : new PgSuppressionRepository(db),
  ),
  repositoryProvider(EMAIL_DELIVERY_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoEmailDeliveryRepository(mongo) : new PgEmailDeliveryRepository(db),
  ),
  repositoryProvider(CONTENT_STAFF_REPOSITORY, (db, mongo) =>
    isMongo() ? new MongoContentStaffRepository(mongo) : new PgContentStaffRepository(db),
  ),
];

@Module({
  providers,
  exports: [
    CAREERS_REPOSITORY,
    CONTACT_INBOX_REPOSITORY,
    CONTENT_REPOSITORY,
    NEWSLETTER_REPOSITORY,
    SUPPRESSION_REPOSITORY,
    EMAIL_DELIVERY_REPOSITORY,
    CONTENT_STAFF_REPOSITORY,
  ],
})
export class CorporateRepositoriesModule {}
