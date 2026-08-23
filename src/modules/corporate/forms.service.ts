import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { sha256Hex, randomToken } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { EmailService } from './email/email.service';
import { careerApplications, contactSubmissions, newsletterSubs } from './public.schema';
import { CareerDto, ContactDto, NewsletterDto } from './dto';

/**
 * The public forms (corporate E-2): contact, newsletter double opt-in,
 * careers. Every submission is IP-rate-limited at the route, idempotent by
 * Idempotency-Key, audited (`corporate.submission`), and stored in
 * platform-plane tables. Honeypot rejection happens in the controller
 * (whitelist rejection is invisible to the caller).
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async submitContact(dto: ContactDto, ip: string | null): Promise<void> {
    await this.db.root.insert(contactSubmissions).values({
      name: dto.name,
      email: dto.email.toLowerCase(),
      company: dto.company ?? null,
      message: dto.message,
      requestIp: ip,
    });
    await this.audit.add({
      action: 'corporate.submission',
      resourceType: 'contact_submission',
      actorType: 'system',
      details: { kind: 'contact', email_domain: dto.email.split('@')[1] ?? '' },
    });
  }

  /**
   * Newsletter subscribe → pending row + confirmation email (double opt-in).
   * Re-subscribing a confirmed address is a silent no-op; re-subscribing a
   * pending one re-issues the token (old one is replaced — single token
   * per address at any time).
   */
  async subscribeNewsletter(dto: NewsletterDto): Promise<void> {
    const email = dto.email.toLowerCase();
    const token = randomToken(32);
    const existing = await this.db.root.select().from(newsletterSubs).where(eq(newsletterSubs.email, email)).limit(1);

    if (existing[0]?.status === 'confirmed') {
      return; // idempotent: already subscribed
    }

    if (existing[0]) {
      await this.db.root
        .update(newsletterSubs)
        .set({ status: 'pending', confirmTokenHash: sha256Hex(token), unsubscribedAt: null })
        .where(eq(newsletterSubs.id, existing[0].id));
    } else {
      await this.db.root
        .insert(newsletterSubs)
        .values({ email, status: 'pending', confirmTokenHash: sha256Hex(token) })
        .onConflictDoNothing({ target: newsletterSubs.email });
      if (!existing.length) {
        // Lost an insert race → treat as existing-pending; refresh token.
        await this.db.root
          .update(newsletterSubs)
          .set({ confirmTokenHash: sha256Hex(token) })
          .where(and(eq(newsletterSubs.email, email), eq(newsletterSubs.status, 'pending')));
      }
    }

    await this.email.sendTemplate({
      template: 'newsletter.double-opt-in',
      to: email,
      vars: {
        confirm_url: `${env.ENGINE_BASE_URL.replace(/\/$/, '')}/public/newsletter/confirm?token=${token}`,
      },
      metadata: { kind: 'newsletter_opt_in' },
    });
    await this.audit.add({
      action: 'corporate.submission',
      resourceType: 'newsletter_sub',
      actorType: 'system',
      details: { kind: 'newsletter_pending', email_domain: email.split('@')[1] ?? '' },
    });
  }

  /** Redeem the confirmation token: single-use, hash-compared, pending-only. */
  async confirmNewsletter(token: string): Promise<boolean> {
    const rows = await this.db.root
      .select()
      .from(newsletterSubs)
      .where(and(eq(newsletterSubs.confirmTokenHash, sha256Hex(token)), eq(newsletterSubs.status, 'pending')))
      .limit(1);
    if (!rows[0]) {
      return false;
    }
    await this.db.root
      .update(newsletterSubs)
      .set({ status: 'confirmed', confirmedAt: new Date().toISOString(), confirmTokenHash: null })
      .where(eq(newsletterSubs.id, rows[0].id));
    await this.audit.add({
      action: 'corporate.newsletter_confirmed',
      resourceType: 'newsletter_sub',
      resourceId: rows[0].id,
      actorType: 'system',
      details: { email_domain: rows[0].email.split('@')[1] ?? '' },
    });
    return true;
  }

  async submitCareer(dto: CareerDto, ip: string | null): Promise<void> {
    await this.db.root.insert(careerApplications).values({
      name: dto.name,
      email: dto.email.toLowerCase(),
      position: dto.position,
      portfolioUrl: dto.portfolio_url ?? null,
      coverNote: dto.cover_note ?? null,
      fileRef: dto.file_ref ?? null,
      requestIp: ip,
    });
    await this.audit.add({
      action: 'corporate.submission',
      resourceType: 'career_application',
      actorType: 'system',
      details: { kind: 'career', position: dto.position.slice(0, 128) },
    });
  }
}
