import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex, randomToken } from '../../common/infra/crypto/envelope';
import { env } from '../../common/config/env';
import { EmailService } from './email/email.service';
import { emailSuppressions, newsletterCampaignSends, newsletterCampaigns, newsletterSubs } from './public.schema';

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
 */
const CAMPAIGN_BATCH = 50;

@Injectable()
export class NewsletterService {
  private static readonly logger = new Logger(NewsletterService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // ── subscriber lifecycle ───────────────────────────────────────────────────

  async subscribe(rawEmail: string, source = 'website'): Promise<void> {
    const email = rawEmail.toLowerCase();
    const confirmToken = randomToken(32);
    const unsubToken = randomToken(24);
    const existing = await this.db.root.select().from(newsletterSubs).where(eq(newsletterSubs.email, email)).limit(1);

    if (existing[0]?.status === 'confirmed') {
      return; // idempotent: already subscribed
    }

    if (existing[0]) {
      await this.db.root
        .update(newsletterSubs)
        .set({
          status: 'pending',
          confirmTokenHash: sha256Hex(confirmToken),
          unsubscribeTokenHash: sha256Hex(unsubToken),
          source,
          unsubscribedAt: null,
        })
        .where(eq(newsletterSubs.id, existing[0].id));
    } else {
      const inserted = await this.db.root
        .insert(newsletterSubs)
        .values({ email, status: 'pending', confirmTokenHash: sha256Hex(confirmToken), unsubscribeTokenHash: sha256Hex(unsubToken), source })
        .onConflictDoNothing({ target: newsletterSubs.email })
        .returning({ id: newsletterSubs.id });
      if (!inserted[0]) {
        // Lost an insert race → treat as existing-pending; refresh the token.
        await this.db.root
          .update(newsletterSubs)
          .set({ confirmTokenHash: sha256Hex(confirmToken) })
          .where(and(eq(newsletterSubs.email, email), eq(newsletterSubs.status, 'pending')));
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
      .set({ status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedIp: ip, confirmTokenHash: null })
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

  /** Subscriber-token unsubscribe (website footer link, hashed lookup). */
  async unsubscribeByToken(token: string): Promise<boolean> {
    if (token.length < 16 || token.length > 128) {
      return false;
    }
    const rows = await this.db.root
      .select()
      .from(newsletterSubs)
      .where(eq(newsletterSubs.unsubscribeTokenHash, sha256Hex(token)))
      .limit(1);
    if (!rows[0]) {
      return false;
    }
    await this.markUnsubscribed(rows[0].id, rows[0].email, 'subscriber token');
    return true;
  }

  /** Per-send-token unsubscribe (campaign links — raw lookup, unique per send). */
  async unsubscribeBySendToken(token: string): Promise<boolean> {
    if (token.length < 16 || token.length > 128) {
      return false;
    }
    const rows = await this.db.root
      .select({ subscriberId: newsletterCampaignSends.subscriberId, email: newsletterCampaignSends.email })
      .from(newsletterCampaignSends)
      .where(eq(newsletterCampaignSends.unsubscribeToken, token))
      .limit(1);
    if (!rows[0]) {
      return false;
    }
    await this.markUnsubscribed(rows[0].subscriberId, rows[0].email, 'campaign link');
    return true;
  }

  private async markUnsubscribed(subscriberId: string, email: string, via: string): Promise<void> {
    await this.db.root
      .update(newsletterSubs)
      .set({ status: 'unsubscribed', unsubscribedAt: new Date().toISOString() })
      .where(eq(newsletterSubs.id, subscriberId));
    // Unsubscribes also land on the suppression list — the hard guarantee
    // that no future campaign ever re-mails them.
    await this.db.root
      .insert(emailSuppressions)
      .values({ email: email.toLowerCase(), reason: 'unsubscribe', detail: `one-click (${via})` })
      .onConflictDoNothing({ target: emailSuppressions.email });
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
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const like = filter.q ? `%${filter.q.replace(/[%_]/g, '')}%` : null;
    const rows = await this.db.root.execute<Record<string, unknown>>(sql`
      select id, email, status, source, confirmed_at, unsubscribed_at, created_at
      from newsletter_subs
      where (${filter.status ?? null}::varchar is null or status = ${filter.status ?? null})
        and (${like}::varchar is null or email like ${like})
      order by created_at desc
      limit ${limit} offset ${offset}
    `);
    const total = await this.db.root.execute<{ count: number }>(sql`
      select count(*)::int as count from newsletter_subs
      where (${filter.status ?? null}::varchar is null or status = ${filter.status ?? null})
        and (${like}::varchar is null or email like ${like})
    `);
    return { subscribers: rows.rows, total: total.rows[0]?.count ?? 0, limit, offset };
  }

  async exportCsv(): Promise<string> {
    const rows = await this.db.root
      .select({ email: newsletterSubs.email, status: newsletterSubs.status, confirmedAt: newsletterSubs.confirmedAt })
      .from(newsletterSubs)
      .orderBy(desc(newsletterSubs.createdAt))
      .limit(50_000);
    const lines = ['email,status,confirmed_at'];
    for (const row of rows) {
      lines.push(`${row.email},${row.status},${row.confirmedAt ?? ''}`);
    }
    return lines.join('\n');
  }

  /** GDPR: the subscriber's own record minus token material. */
  async subscriberData(email: string): Promise<unknown> {
    const rows = await this.db.root.select().from(newsletterSubs).where(eq(newsletterSubs.email, email.toLowerCase())).limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('subscriber');
    }
    return {
      id: rows[0].id,
      email: rows[0].email,
      status: rows[0].status,
      source: rows[0].source,
      confirmed_at: rows[0].confirmedAt,
      unsubscribed_at: rows[0].unsubscribedAt,
      created_at: rows[0].createdAt,
    };
  }

  async deleteSubscriber(email: string, actorId: string): Promise<void> {
    const deleted = await this.db.root
      .delete(newsletterSubs)
      .where(eq(newsletterSubs.email, email.toLowerCase()))
      .returning({ id: newsletterSubs.id });
    if (!deleted[0]) {
      throw ApiError.notFound('subscriber');
    }
    await this.audit.add({
      action: 'corporate.subscriber_deleted',
      resourceType: 'newsletter_sub',
      resourceId: deleted[0].id,
      actorType: 'account',
      actorId,
      details: { gdpr: true },
    });
  }

  // ── campaigns ──────────────────────────────────────────────────────────────

  async createCampaign(input: { subject: string; preheader?: string; bodyMd: string; actorId: string }) {
    if (input.subject.trim().length < 3) {
      throw ApiError.validation({ subject: '3..512 characters' });
    }
    const inserted = await this.db.root
      .insert(newsletterCampaigns)
      .values({ subject: input.subject.slice(0, 512), preheader: input.preheader?.slice(0, 256), bodyMd: input.bodyMd, createdBy: null })
      .returning();
    await this.audit.add({
      action: 'corporate.campaign_created',
      resourceType: 'newsletter_campaign',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      details: { subject: input.subject.slice(0, 200) },
    });
    return inserted[0];
  }

  async updateCampaign(input: { campaignId: string; subject?: string; preheader?: string; bodyMd?: string; actorId: string }) {
    const existing = await this.requireCampaign(input.campaignId);
    if (existing.status !== 'draft') {
      throw ApiError.conflict(`only draft campaigns can be edited (state: ${existing.status})`);
    }
    const updated = await this.db.root
      .update(newsletterCampaigns)
      .set({
        ...(input.subject !== undefined ? { subject: input.subject.slice(0, 512) } : {}),
        ...(input.preheader !== undefined ? { preheader: input.preheader?.slice(0, 256) } : {}),
        ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(newsletterCampaigns.id, input.campaignId))
      .returning();
    return updated[0];
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

    const recipients = await this.db.root.execute<{ id: string; email: string }>(sql`
      select s.id, s.email from newsletter_subs s
      where s.status = 'confirmed'
        and not exists (select 1 from email_suppressions e where e.email = s.email and e.resolved_at is null)
    `);
    if (recipients.rows.length === 0) {
      throw ApiError.conflict('no recipients (confirmed, non-suppressed) — nothing to schedule');
    }

    await this.db.root.transaction(async (tx) => {
      await tx
        .update(newsletterCampaigns)
        .set({ status: 'scheduled', scheduledAt, recipientCount: recipients.rows.length, updatedAt: new Date().toISOString() })
        .where(eq(newsletterCampaigns.id, input.campaignId));
      for (const row of recipients.rows) {
        await tx
          .insert(newsletterCampaignSends)
          .values({ campaignId: input.campaignId, subscriberId: row.id, email: row.email, unsubscribeToken: randomToken(24) })
          .onConflictDoNothing();
      }
    });
    await this.audit.add({
      action: 'corporate.campaign_scheduled',
      resourceType: 'newsletter_campaign',
      resourceId: input.campaignId,
      actorType: 'account',
      actorId: input.actorId,
      details: { recipients: String(recipients.rows.length), scheduled_at: scheduledAt },
    });
    return { scheduled_at: scheduledAt, recipients: recipients.rows.length };
  }

  async cancelCampaign(input: { campaignId: string; actorId: string }) {
    const campaign = await this.requireCampaign(input.campaignId);
    if (campaign.status !== 'scheduled' && campaign.status !== 'sending') {
      throw ApiError.conflict(`only scheduled/sending campaigns can be cancelled (state: ${campaign.status})`);
    }
    await this.db.root
      .update(newsletterCampaigns)
      .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
      .where(eq(newsletterCampaigns.id, input.campaignId));
    await this.audit.add({
      action: 'corporate.campaign_cancelled',
      resourceType: 'newsletter_campaign',
      resourceId: input.campaignId,
      actorType: 'account',
      actorId: input.actorId,
      details: {},
    });
  }

  async listCampaigns() {
    return this.db.root.select().from(newsletterCampaigns).orderBy(desc(newsletterCampaigns.createdAt)).limit(200);
  }

  async campaignDetail(campaignId: string) {
    const campaign = await this.requireCampaign(campaignId);
    const counts = await this.db.root.execute<{ status: string; count: number }>(sql`
      select status, count(*)::int as count from newsletter_campaign_sends where campaign_id = ${campaignId} group by status
    `);
    return { campaign, send_counts: counts.rows };
  }

  /**
   * The worker entry: promote due scheduled campaigns, then advance every
   * in-flight campaign by one batch. Returns remaining queued work so the
   * worker re-enqueues itself while work exists.
   */
  async processCampaigns(): Promise<{ processed: number; remaining: number }> {
    await this.db.root.execute(sql`
      update newsletter_campaigns set status = 'sending', updated_at = now()
      where status = 'scheduled' and scheduled_at <= now()
    `);
    const inflight = await this.db.root
      .select({ id: newsletterCampaigns.id })
      .from(newsletterCampaigns)
      .where(eq(newsletterCampaigns.status, 'sending'));
    let remaining = 0;
    for (const campaign of inflight) {
      remaining += await this.sendBatch(campaign.id);
    }
    return { processed: inflight.length, remaining };
  }

  /** One throttled batch; returns the campaign's remaining queue size. */
  private async sendBatch(campaignId: string): Promise<number> {
    const campaignRows = await this.db.root.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, campaignId)).limit(1);
    const campaign = campaignRows[0];
    if (!campaign || campaign.status !== 'sending') {
      return 0;
    }
    const pending = await this.db.root
      .select()
      .from(newsletterCampaignSends)
      .where(and(eq(newsletterCampaignSends.campaignId, campaignId), eq(newsletterCampaignSends.status, 'queued')))
      .limit(CAMPAIGN_BATCH);

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
        await this.db.root
          .update(newsletterCampaignSends)
          .set({ status: 'sent', sentAt: new Date().toISOString() })
          .where(eq(newsletterCampaignSends.id, send.id));
        await this.db.root
          .update(newsletterCampaigns)
          .set({ sentCount: sql`${newsletterCampaigns.sentCount} + 1`, updatedAt: new Date().toISOString() })
          .where(eq(newsletterCampaigns.id, campaignId));
      } catch (err) {
        const message = (err as Error).message.slice(0, 480);
        const skipped = message.includes('suppressed');
        await this.db.root
          .update(newsletterCampaignSends)
          .set({ status: skipped ? 'skipped_suppressed' : 'failed', error: skipped ? null : message })
          .where(eq(newsletterCampaignSends.id, send.id));
        if (!skipped) {
          await this.db.root
            .update(newsletterCampaigns)
            .set({ failedCount: sql`${newsletterCampaigns.failedCount} + 1`, updatedAt: new Date().toISOString() })
            .where(eq(newsletterCampaigns.id, campaignId));
        }
      }
    }

    // Remaining queue + completion flip.
    const remainingRows = await this.db.root
      .select({ count: sql<number>`count(*)::int` })
      .from(newsletterCampaignSends)
      .where(and(eq(newsletterCampaignSends.campaignId, campaignId), eq(newsletterCampaignSends.status, 'queued')));
    const remaining = remainingRows[0]?.count ?? 0;
    if (remaining === 0 && pending.length > 0) {
      await this.db.root
        .update(newsletterCampaigns)
        .set({ status: 'sent', sentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(newsletterCampaigns.id, campaignId));
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

  private async requireCampaign(campaignId: string) {
    const rows = await this.db.root.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, campaignId)).limit(1);
    if (!rows[0]) {
      throw ApiError.notFound('campaign');
    }
    return rows[0];
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
