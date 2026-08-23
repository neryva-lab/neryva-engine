import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { PlatformStaffGuard } from '../../common/policy/staff.guard';
import { RevocationLogService } from './revocation-log.service';
import { RevocationsController } from './revocations.controller';
import { SatelliteActivityService } from './satellite-activity.service';
import { SatelliteIncidentsService } from './satellite-incidents.service';
import { SatelliteRegistryService } from './satellite-registry.service';
import { SatelliteSweeperWorker } from './satellite-sweeper.worker';
import { SatellitesController } from './satellites.controller';

/**
 * The satellites module (ADR-006 D2/D4, ledger agent-runtime + inference;
 * dense pass eng-0010): the full capability-deployment lifecycle —
 * registration, heartbeat leases with directives, quarantine/drain/retire,
 * the incident timeline, per-scope compliance evidence, the minute sweeper
 * (liveness transitions + retention + config drift), and the revocation
 * feed. This is the ENGINE side of the pattern both satellites connect
 * through — agent-runtime live today, inference pre-registered as a
 * placeholder.
 *
 * Flag: MODULES__SATELLITES_ENABLED (requires identity: heartbeats
 * authenticate on L3 service tokens).
 */
@Module({
  controllers: [SatellitesController, RevocationsController],
  providers: [SatelliteRegistryService, SatelliteIncidentsService, SatelliteActivityService, SatelliteSweeperWorker, RevocationLogService, PlatformStaffGuard],
  exports: [SatelliteRegistryService, SatelliteIncidentsService, SatelliteActivityService, RevocationLogService],
})
export class SatellitesModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('satellites', () => db.check());
  }
}
