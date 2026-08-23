import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookWorker } from './webhook.worker';

/**
 * The outbound-webhooks platform service (gap P-1/S-1): org-owned event
 * endpoints with HMAC signatures, bounded retries, and a durable delivery
 * log. Subscribes to the engine event bus (NO module imports beyond
 * organizations for the roles guard) — entitlement/billing/deployment/org
 * events fan out with zero coupling to their modules.
 *
 * Flag: MODULES__WEBHOOKS_ENABLED (requires organizations).
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookWorker],
  exports: [WebhooksService],
})
export class WebhooksModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('webhooks', () => db.check());
  }
}
