import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { ContentService } from './content.service';
import { ContentController } from './content.controller';
import { ContentStaffGuard } from './content-staff.guard';
import { EmailService } from './email/email.service';
import { FormsService } from './forms.service';
import { PublicController } from './public.controller';

/**
 * The corporate module (ADR-004 D3 + ADR-007 D3: fresh NestJS, no Express
 * port). Phases shipped here:
 *
 *  - E-1: the email service (platform facility — identity login codes and
 *    org invites send through it).
 *  - E-2: the public form endpoints (/public/{contact,newsletter,careers})
 *    with rate limits, honeypot-by-whitelist, idempotency, and audit rows.
 *  - E-3: content admin (/console/content/**, L1 + staff grant; grant
 *    management is operator-only L2) and the /public/blog export feed the
 *    website build syncs from.
 *
 * Remaining (P6): the website re-point, Mongo→Postgres data migration, and
 * neryva_backend retirement.
 */
@Module({
  controllers: [PublicController, ContentController],
  providers: [EmailService, FormsService, ContentService, ContentStaffGuard],
  exports: [EmailService, ContentService],
})
export class CorporateModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('corporate', () => db.check());
  }
}
