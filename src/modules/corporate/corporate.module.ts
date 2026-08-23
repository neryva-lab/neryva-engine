import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { CareersService } from './careers.service';
import { ContactInboxService } from './contact-inbox.service';
import { ContentService } from './content.service';
import { ContentController } from './content.controller';
import { ContentStaffGuard } from './content-staff.guard';
import { CorporateWorker } from './corporate.worker';
import { EmailService } from './email/email.service';
import { FeedsService } from './feeds.service';
import { InboxController } from './inbox.controller';
import { NewsletterService } from './newsletter.service';
import { PublicController } from './public.controller';
import { SuppressionService } from './suppression.service';

/**
 * The corporate module (ADR-004 D3 + ADR-007 D3: fresh NestJS, no Express
 * port) — neryva.com's duties at production grade:
 *
 *  - E-1 email: transport port + templates + delivery audit + SUPPRESSION
 *    list (bounce/complaint webhooks, one-click unsubscribe) + List-
 *    Unsubscribe/RFC 8058 headers on bulk mail.
 *  - E-2 public forms: contact (ack + team notify + opt-in handoff),
 *    newsletter (double opt-in + one-click unsubscribe + CAMPAIGNS with
 *    throttled, resumable, suppression-aware sends), careers (managed job
 *    postings + the full application pipeline).
 *  - E-3 content: CMS discipline (immutable revisions + restore, scheduled
 *    publishing, SEO/category/featured), staff inbox surfaces, the
 *    static-site export bundle, and RSS/Atom/JSON/sitemap syndication.
 *
 * Remaining (P6): the website re-point, Mongo→Postgres data migration, and
 * neryva_backend retirement.
 */
@Module({
  controllers: [PublicController, ContentController, InboxController],
  providers: [
    EmailService,
    SuppressionService,
    NewsletterService,
    ContactInboxService,
    CareersService,
    ContentService,
    FeedsService,
    ContentStaffGuard,
    CorporateWorker,
  ],
  exports: [EmailService, ContentService, SuppressionService, NewsletterService],
})
export class CorporateModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('corporate', () => db.check());
  }
}
