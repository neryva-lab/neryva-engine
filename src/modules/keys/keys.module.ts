import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KeysController } from './keys.controller';
import { KeysWorker } from './keys.worker';
import { KeysService } from './keys.service';

/**
 * The keys module — engine side of handover A-1 (key/token authority):
 * console CRUD for org `nrv_live_` keys (the documented dual-write window
 * on the Python-owned api_keys table) and the satellite validation
 * endpoint the runtime caches against.
 *
 * Flag: MODULES__KEYS_ENABLED (requires organizations for the org guards).
 */
@Module({
  imports: [OrganizationsModule, NotificationsModule],
  controllers: [KeysController],
  providers: [KeysService, KeysWorker],
  exports: [KeysService],
})
export class KeysModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('keys', () => db.check());
  }
}
