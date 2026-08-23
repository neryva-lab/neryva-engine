import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { ConsoleModule } from '../console/console.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SatellitesModule } from '../satellites/satellites.module';
import { ConfigPublishController } from './config-publish.controller';
import { ConfigPullController } from './config-pull.controller';
import { ConfigPublishService } from './config-publish.service';
import { ConfigPublishWorker } from './config-publish.worker';

/**
 * The config-publish module — engine side of handover A-4: versioned,
 * immutable, audited policy/guardrail/quota/model-catalog documents per
 * (org × scope × product), a draft→validate→publish→rollback editor on the
 * console side, a durable satellite notification ledger with ACK tracking
 * and delivery observability, and the retention/stale sweeps that keep the
 * store bounded.
 *
 * Flag: MODULES__CONFIG_PUBLISH_ENABLED (requires organizations for the
 * console guards, satellites for the fanout ledger + quarantine gate, and
 * console for the manifest registry's product-tag check).
 */
@Module({
  imports: [ConsoleModule, OrganizationsModule, SatellitesModule],
  controllers: [ConfigPublishController, ConfigPullController],
  providers: [ConfigPublishService, ConfigPublishWorker],
  exports: [ConfigPublishService],
})
export class ConfigPublishModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('config-publish', () => db.check());
  }
}
