import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SatellitesModule } from '../satellites/satellites.module';
import { ConfigPublishController } from './config-publish.controller';
import { ConfigPublishService } from './config-publish.service';

/**
 * The config-publish module — engine side of handover A-4: versioned,
 * immutable, audited policy/guardrail/quota/model-catalog documents per
 * (org × scope × product), a durable satellite notification ledger, and
 * the console publish surface (step-up gated — policy publish stays on the
 * privileged-act list).
 *
 * Flag: MODULES__CONFIG_PUBLISH_ENABLED (requires organizations for the
 * console guards; satellites for the fanout ledger).
 */
@Module({
  imports: [OrganizationsModule, SatellitesModule],
  controllers: [ConfigPublishController],
  providers: [ConfigPublishService],
  exports: [ConfigPublishService],
})
export class ConfigPublishModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('config-publish', () => db.check());
  }
}
