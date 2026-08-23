import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { CorporateModule } from '../corporate/corporate.module';
import { IdentityModule } from '../identity/identity.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * The notifications platform service (gap P-2): the account-facing feed +
 * email fan-out every alerting path (billing anomalies, entitlement
 * trouble, org changes, deployment outcomes, dead webhooks) writes to.
 * Subscribes to the engine event bus — no coupling to emitting modules.
 *
 * Flag: MODULES__NOTIFICATIONS_ENABLED (requires organizations; emails ride
 * the corporate transport).
 */
@Module({
  imports: [CorporateModule, IdentityModule, OrganizationsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('notifications', () => db.check());
  }
}
