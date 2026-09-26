import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { IMPERSONATION_REPOSITORY, PLATFORM_STAFF_REPOSITORY } from './repository-tokens';
import { PgImpersonationRepository } from './pg-impersonation.repository';
import { MongoImpersonationRepository } from './mongo-impersonation.repository';
import { PgPlatformStaffRepository } from './pg-platform-staff.repository';
import { MongoPlatformStaffRepository } from './mongo-platform-staff.repository';

/**
 * Provider selection for the staff persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 *
 * Session-row writes (`oauth_sessions`) stay with the identity module's
 * `ISessionRepository` — the staff module never owns that table.
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
      IMPERSONATION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoImpersonationRepository(mongo) : new PgImpersonationRepository(db)),
    ),
    repositoryProvider(
      PLATFORM_STAFF_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoPlatformStaffRepository(mongo) : new PgPlatformStaffRepository(db)),
    ),
  ],
  exports: [IMPERSONATION_REPOSITORY, PLATFORM_STAFF_REPOSITORY],
})
export class StaffRepositoriesModule {}
