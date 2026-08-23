import { Module } from '@nestjs/common';
import { EmailService } from './email/email.service';

/**
 * The corporate module (ADR-004 D3 + ADR-007 D3: fresh NestJS, no Express
 * port). Phase E-1 ships the email service (a platform facility hosted
 * here); the /public forms, content admin, and neryva_backend retirement
 * land in later phases per dev/corporate/plan.md.
 *
 * Public interface: EmailService (platform modules inject it for their own
 * transactional sends — identity login codes, org invites).
 */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class CorporateModule {}
