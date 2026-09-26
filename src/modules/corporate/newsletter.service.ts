import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex, randomToken } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { EmailService } from './email/email.service';
import { NEWSLETTER_REPOSITORY } from './repositories/repository-tokens';
import type { INewsletterRepository, NewsletterCampaignRow } from './repositories/newsletter.repository';

/**
 * Newsletter v2 (E-2 to production grade): the full subscriber lifecycle —
 * double opt-in (the E-2 baseline), per-subscriber unsubscribe tokens
 * (one-click GET/POST + RFC 8058 List-Unsubscribe headers on every bulk
 * mail), resubscribe, staff management (list/filter/CSV export), GDPR
 * export + erasure — and CAMPAIGNS: staff-authored broadcasts the worker
 * sends in throttled, resumable batches, suppression-enforced, with a
 * durable per-recipient record (unique per campaign+subscriber → a crashed
 * send resumes exactly where it stopped).
 *
 * Unsubscribe tokens: each subscriber carries a hashed long-lived token
 * (the website footer link); each CAMPAIGN SEND carries its own raw
 * per-send token (the emailed link) so campaign links are unique,
 * rotatable per campaign, and reveal nothing about the subscriber table.
 * Both paths land on the suppression list — the hard no-more-mail guarantee.
 *
 * Persistence-blind (P3): all storage goes through `INewsletterRepository`.
 * Corporate tables are global (non-tenant). Campaign scheduling keeps its
 * single-transaction boundary (campaign flip + send-row snapshot) in the
 * repository.
 */
const CAMPAIGN_BATCH = 50;

@Injectable()
export class NewsletterService {
  private static readonly logger = new Logger(NewsletterService.name);

  constructor(
    @Inject(NEWSLETTER_REPOSITORY) private readonly newsletter: INewsletterRepository,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // ── subscriber lifecycle ───────────────────────────────────────────────────

  async subscribe(rawEmail: string, source = 'website'): Promise<void> {
    const email = rawEmail.toLowerCase();
    const confirmToken = randomToken(32);
    const unsubToken = randomToken(24);
    const existing = await this.newsletter.getSubscriberByEmail(email);

    if (existing?.status === 'confirmed') {
      return; // idempotent: already subscribed
    }

    if (existing) {
      await this.newsletter.refreshPendingSubscriber({
        id: existing.id,
        confirmTokenHash: sha256Hex(confirmToken),
        unsubscribeTokenHash: sha256Hex(unsubToken),
        source,
      });
    } else {
      const inserted = await this.newsletter.insertPendingSubscriber({
        email,
        confirmTokenHash: sha256Hex(confirmToken),
        unsubscribeTokenHash: sha256Hex(unsubToken),
        source,
      });
      if (!inserted) {
        // Lost an insert race → treat as existing-pending; refresh the token.
        await this.newsletter.refreshConfirmToken(email, sha256Hex(confirmToken));
      }
    }

    await this.email.sendTemplate({
      template: 'newsletter.double-opt-in',
      to: email,
      vars: { confirm_url: this.publicUrl(`/public/newsletter/confirm?token=${confirmToken}`) },
      metadata: { kind: 'newsletter_opt_in' },
    });
    await this.audit.add({
      action: 'corporate.submission',
      resourceType: 'newsletter_sub',
      actorType: 'system',
      details: { kind: 'newsletter_pending', source, email_domain: email.split('@')[1] ?? '' },
    });
  }

  /** Redeem the double-opt-in token (single-use, pending-only). */
  async confirm(token: string, ip: string | null = null): Promise<boolean> {
    const row = await this.newsletter.findPendingByConfirmTokenHash(sha256Hex(token));
    if (!row) {
      return false;
    }
    await this.newsletter.confirmSubscriber({ id: row.id, ip });
    await this.audit.add({
      action: 'corporate.newsletter_confirmed',
      resourceType: 'newsletter_sub',
      resourceId: row.id,
      actorType: 'system',
      details: { email_domain: row.email.split('@')[1] ?? '' },
    });
    return true;
  }

  /** Subscriber-token unsubscribe (website footer link, hashed lookup). */
  async unsubscribeByToken(token: string): Promise<boolean> {
    if (token.length < 16 || token.length > 128) {
      return false;
    }
    const row = await this.newsletter.findByUnsubscribeTokenHash(sha256Hex(token));
    if (!row) {
      return false;
    }
    await this.markUnsubscribed(row.id, row.email, 'subscriber token');
    return true;
  }

  /** Per-send-token unsubscribe (campaign links — raw lookup, unique per send). */
  async unsubscribeBySendToken(token: string): Promise<boolean> {
    if (token.length < 16 || token.length > 128) {
      return false;
    }
    const row = await this.newsletter.findSendByUnsubscribeToken(token);
    if (!row) {
      return false;
    }
    await this.markUnsubscribed(row.subscriberId, row.email, 'campaign link');
    return true;
  }

  private async markUnsubscribed(subscriberId: string, email: string, via: string): Promise<void> {
    // Unsubscribes also land on the suppression list — the hard guarantee
    // that no future campaign ever re-mails them (one chokepoint, in the repo).
    await this.newsletter.markUnsubscribed({ subscriberId, email, via });
    await this.audit.add({
      action: 'corporate.newsletter_unsubscribed',
      resourceType: 'newsletter_sub',
      resourceId: subscriberId,
      actorType: 'system',
      details: { via, email_domain: email.split('@')[1] ?? '' },
    });
  }

  // ── staff: list / filter / export / GDPR ───────────────────────────────────

  async listSubscribers(filter: { status?: string; q?: string; limit?: number; offset?: number }) {
    return this.newsletter.listSubscribers(filter);
  }

  async exportCsv(): Promise<string> {
    const rows = await this.newsletter.exportSubscriberRows();
    const lines = ['email,status,confirmed_at'];
    for (const row of rows) {
      lines.push(`${row.email},${row.status},${row.confirmedAt ?? ''}`);
    }
    return lines.join('\n');
  }

  /** GDPR: the subscriber's own record minus token material. */
  async subscriberData(email: string): Promise<unknown> {
    const row = await this.newsletter.getSubscriberByEmail(email.toLowerCase());
    if (!row) {
      throw ApiError.notFound('subscriber');
    }
    return {
      id: row.id,
      email: row.email,
      status: row.status,
      source: row.source,
      confirmed_at: row.confirmedAt,
      unsubscribed_at: row.unsubscribedAt,
      created_at: row.createdAt,
    };
  }

  async deleteSubscriber(email: string, actorId: string): Promise<void> {
    const deletedId = await this.newsletter.deleteSubscriberByEmail(email);
    if (!deletedId) {
      throw ApiError.notFound('subscriber');
    }
    await this.audit.add({
      action: 'corporate.subscriber_deleted',
      resourceType: 'newsletter_sub',
      resourceId: deletedId,
      actorType: 'account',
      actorId,
      details: { gdpr: true },
    });
  }

  // ── campaigns ──────────────────────────────────────────────────────────────

  async createCampaign(input: { subject: string; preheader?: string; bodyMd: string; actorId: string }): Promise<NewsletterCampaignRow> {
    if (input.subject.trim().length < 3) {
      throw ApiError.validation({ subject: '3..512 characters' });
    }
    const row = await this.newsletter.createCampaign({
      subject: input.subject,
      preheader: input.preheader,
      bodyMd: input.bodyMd,
    });
    await this.audit.add({
      action: 'corporate.campaign_created',
      resourceType: 'newsletter_campaign',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      details: { subject: input.subject.slice(0, 200) },
    });
    return row;
  }

  async updateCampaign(input: { campaignId: string; subject?: string; preheader?: string; bodyMd?: string; actorId: string }): Promise<NewsletterCampaignRow> {
    const existing = await this.requireCampaign(input.campaignId);
    if (existing.status !== 'draft') {
      throw ApiError.conflict(`only draft campaigns can be edited (state: ${existing.status})`);
    }
    const updated = await this.newsletter.updateCampaign({
      campaignId: input.campaignId,
      subject: input.subject,
      preheader: input.preheader,
      bodyMd: input.bodyMd,
    });
    if (!updated) {
      throw ApiError.notFound('campaign');
    }
    return updated;
  }

  /**
   * Schedule: freezes content, snapshots the recipient list (confirmed,
   * non-suppressed) as queued send rows with per-send unsubscribe tokens,
   * and flips to `scheduled`. The worker takes over at scheduledAt.
   */
  async scheduleCampaign(input: { campaignId: string; scheduledAt?: string; actorId: string }) {
    const campaign = await this.requireCampaign(input.campaignId);
    if (campaign.status !== 'draft') {
      throw ApiError.conflict(`only draft campaigns can be scheduled (state: ${campaign.status})`);
    }
    const scheduledAt = input.scheduledAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(scheduledAt))) {
      throw ApiError.validation({ scheduled_at: 'ISO-8601 required' });
    }

    const recipients = await this.newsletter.confirmedRecipients();
    if (recipients.length === 0) {
      throw ApiError.conflict('no recipients (confirmed, non-suppressed) — nothing to schedule');
    }

    await this.newsletter.scheduleCampaign({
      campaignId: input.campaignId,
      scheduledAt,
      recipients,
      makeToken: () => randomToken(24),
    });
    await this.audit.add({
      action: 'corporate.campaign_scheduled',
      resourceType: 'newsletter_campaign',
      resourceId: input.campaignId,
      actorType: 'account',
      actorId: input.actorId,
      details: { recipients: String(recipients.length), scheduled_at: scheduledAt },
    });
    return { scheduled_at: scheduledAt, recipients: recipients.length };
  }

  async cancelCampaign(input: { campaignId: string; actorId: string }) {
    const campaign = await this.requireCampaign(input.campaignId);
    if (campaign.status !== 'scheduled' && campaign.status !== 'sending') {
      throw ApiError.conflict(`only scheduled/sending campaigns can be cancelled (state: ${campaign.status})`);
    }
    await this.newsletter.cancelCampaign(input.campaignId);
    await this.audit.add({
      action: 'corporate.campaign_cancelled',
      resourceType: 'newsletter_campaign',
      resourceId: input.campaignId,
      actorType: 'account',
      actorId: input.actorId,
      details: {},
    });
  }

  async listCampaigns(): Promise<NewsletterCampaignRow[]> {
    return this.newsletter.listCampaigns();
  }

  async campaignDetail(campaignId: string) {
    const campaign = await this.requireCampaign(campaignId);
    const sendCounts = await this.newsletter.campaignSendCounts(campaignId);
    return { campaign, send_counts: sendCounts };
  }

  /**
   * The worker entry: promote due scheduled campaigns, then advance every
   * in-flight campaign by one batch. Returns remaining queued work so the
   * worker re-enqueues itself while work exists.
   */
  async processCampaigns(): Promise<{ processed: number; remaining: number }> {
    await this.newsletter.promoteDueCampaigns();
    const inflight = await this.newsletter.inflightCampaigns();
    let remaining = 0;
    for (const campaignId of inflight) {
      remaining += await this.sendBatch(campaignId);
    }
    return { processed: inflight.length, remaining };
  }

  /** One throttled batch; returns the campaign's remaining queue size. */
  private async sendBatch(campaignId: string): Promise<number> {
    const campaign = await this.newsletter.getCampaign(campaignId);
    if (!campaign || campaign.status !== 'sending') {
      return 0;
    }
    const pending = await this.newsletter.queuedSends(campaignId, CAMPAIGN_BATCH);

    for (const send of pending) {
      const unsubUrl = this.publicUrl(`/public/newsletter/unsubscribe?token=${send.unsubscribeToken}`);
      const bodyText = markdownToText(campaign.bodyMd);
      try {
        await this.email.sendTemplate({
          template: 'newsletter.campaign',
          to: send.email,
          vars: {
            subject: campaign.subject,
            preheader: campaign.preheader ?? '',
            body_text: bodyText.slice(0, 60_000),
            unsubscribe_url: unsubUrl,
          },
          metadata: { campaign_id: campaignId, subscriber_id: send.subscriberId },
          unsubscribeUrl: unsubUrl,
        });
        await this.newsletter.markSendSent(send.id);
        await this.newsletter.bumpCampaignCounters({ campaignId, sent: true });
      } catch (err) {
        const message = (err as Error).message.slice(0, 480);
        const skipped = message.includes('suppressed');
        await this.newsletter.markSendFailed({
          sendId: send.id,
          skippedSuppressed: skipped,
          error: skipped ? null : message,
        });
        if (!skipped) {
          await this.newsletter.bumpCampaignCounters({ campaignId, failed: true });
        }
      }
    }

    // Remaining queue + completion flip.
    const remaining = await this.newsletter.remainingQueuedSends(campaignId);
    if (remaining === 0 && pending.length > 0) {
      await this.newsletter.completeCampaign(campaignId);
      await this.audit.add({
        action: 'corporate.campaign_sent',
        resourceType: 'newsletter_campaign',
        resourceId: campaignId,
        actorType: 'system',
        details: { sent: String(campaign.sentCount + pending.length) },
      });
    }
    return remaining;
  }

  private async requireCampaign(campaignId: string): Promise<NewsletterCampaignRow> {
    const row = await this.newsletter.getCampaign(campaignId);
    if (!row) {
      throw ApiError.notFound('campaign');
    }
    return row;
  }

  private publicUrl(path: string): string {
    return `${(env.ENGINE_UI_BASE_URL || env.ENGINE_BASE_URL).replace(/\/$/, '')}${path}`;
  }
}

/**
 * Markdown → readable text (no external dependency): headings emphasize,
 * links keep href + label, images drop, emphasis unwraps. Deliberately
 * conservative — emails' canonical content is the text; HTML wraps it.
 */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s*(.+)$/gm, '$1 —')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^>\s?(.+)$/gm, '“$1”')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
