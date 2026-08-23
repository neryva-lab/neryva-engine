import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { SatelliteRegistryService } from './satellite-registry.service';
import { SatellitesController } from './satellites.controller';

/**
 * The satellites module (ADR-006 D2/D4, ledger agent-runtime + inference):
 * the registry of capability deployments and their heartbeats. This is the
 * ENGINE side of the pattern both satellites connect through —
 * agent-runtime live today, inference pre-registered as a placeholder.
 *
 * Flag: MODULES__SATELLITES_ENABLED (requires identity: heartbeats
 * authenticate on L3 service tokens).
 */
@Module({
  controllers: [SatellitesController],
  providers: [SatelliteRegistryService],
  exports: [SatelliteRegistryService],
})
export class SatellitesModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('satellites', () => db.check());
  }
}
