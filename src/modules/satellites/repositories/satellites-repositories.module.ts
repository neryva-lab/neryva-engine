/**
 * Provider selection for the satellites persistence ports (P3).
 *
 * This module is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementations, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 */
import { Module } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { env } from '../../../common/config/env';
import {
  SATELLITE_ACTIVITY_REPOSITORY,
  SATELLITE_INCIDENT_REPOSITORY,
  SATELLITE_REGISTRY_REPOSITORY,
  REVOCATION_LOG_REPOSITORY,
} from './repository-tokens';
import { PgSatelliteRegistryRepository } from './pg-satellite-registry.repository';
import { MongoSatelliteRegistryRepository } from './mongo-satellite-registry.repository';
import { PgSatelliteIncidentRepository } from './pg-satellite-incident.repository';
import { MongoSatelliteIncidentRepository } from './mongo-satellite-incident.repository';
import { PgSatelliteActivityRepository } from './pg-satellite-activity.repository';
import { MongoSatelliteActivityRepository } from './mongo-satellite-activity.repository';
import { PgRevocationLogRepository } from './pg-revocation-log.repository';
import { MongoRevocationLogRepository } from './mongo-revocation-log.repository';

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
      SATELLITE_REGISTRY_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoSatelliteRegistryRepository(mongo) : new PgSatelliteRegistryRepository(db)),
    ),
    repositoryProvider(
      SATELLITE_INCIDENT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoSatelliteIncidentRepository(mongo) : new PgSatelliteIncidentRepository(db)),
    ),
    repositoryProvider(
      SATELLITE_ACTIVITY_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoSatelliteActivityRepository(mongo) : new PgSatelliteActivityRepository(db)),
    ),
    repositoryProvider(
      REVOCATION_LOG_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRevocationLogRepository(mongo) : new PgRevocationLogRepository(db)),
    ),
  ],
  exports: [
    SATELLITE_REGISTRY_REPOSITORY,
    SATELLITE_INCIDENT_REPOSITORY,
    SATELLITE_ACTIVITY_REPOSITORY,
    REVOCATION_LOG_REPOSITORY,
  ],
})
export class SatellitesRepositoriesModule {}
