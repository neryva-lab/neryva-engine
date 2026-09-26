/**
 * PostgreSQL newsletter repository (P3) — `newsletter_subs` +
 * `newsletter_campaigns` + `newsletter_campaign_sends`.
 * Mechanical move of the `NewsletterService` persistence. Corporate tables
 * are global (non-tenant, no RLS) — every method runs through `withBypass`,
 * matching the original `db.root` usage.
 *
 * `scheduleCampaign` keeps the original single-transaction boundary
 * (campaign flip + queued send rows), which `withBypass` provides.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { emailSuppressions, newsletterCampaignSends, newsletterCampaigns, newsletterSubs } from '../public.schema';
import type {
  CampaignRecipient,
  CreateCampaignInput,
  INewsletterRepository,
  NewsletterCampaignRow,
  NewsletterCampaignSendRow,
  NewsletterSubRow,
  QueuedSend,
  UpdateCampaignInput,
  UpsertSubscriberInput,
} from './newsletter.repository';

export class PgNewsletterRepository implements INewsletterRepository {
  constructor(private readonly db: DbService) {}

  async getSubscriberByEmail(email: string): Promise<NewsletterSubRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(newsletterSubs).where(eq(newsletterSubs.email, email)).limit(1),
    );
    return rows[0] ?? null;
  }

  async insertPendingSubscriber(input: UpsertSubscriberInput): Promise<{ id: string } | null> {
    const inserted = await this.db.withBypass((tx) =>
      tx
        .insert(newsletterSubs)
        .values({
          email: input.email,
          status: 'pending',
          confirmTokenHash: input.confirmTokenHash,
          unsubscribeTokenHash: input.unsubscribeTokenHash,
          source: input.source,
        })
        .onConflictDoNothing({ target: newsletterSubs.email })
        .returning({ id: newsletterSubs.id }),
    );
    return inserted[0] ?? null;
  }

  async refreshPendingSubscriber(input: { id: string; confirmTokenHash: string; unsubscribeTokenHash: string; source: string }): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterSubs)
        .set({
          status: 'pending',
          confirmTokenHash: input.confirmTokenHash,
          unsubscribeTokenHash: input.unsubscribeTokenHash,
          source: input.source,
          unsubscribedAt: null,
        })
        .where(eq(newsletterSubs.id, input.id)),
    );
  }

  async refreshConfirmToken(email: string, confirmTokenHash: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterSubs)
        .set({ confirmTokenHash })
        .where(and(eq(newsletterSubs.email, email), eq(newsletterSubs.status, 'pending'))),
    );
  }

  async findPendingByConfirmTokenHash(confirmTokenHash: string): Promise<NewsletterSubRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select()
        .from(newsletterSubs)
        .where(and(eq(newsletterSubs.confirmTokenHash, confirmTokenHash), eq(newsletterSubs.status, 'pending')))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async confirmSubscriber(input: { id: string; ip: string | null }): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterSubs)
        .set({ status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedIp: input.ip, confirmTokenHash: null })
        .where(eq(newsletterSubs.id, input.id)),
    );
  }

  async findByUnsubscribeTokenHash(unsubscribeTokenHash: string): Promise<NewsletterSubRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(newsletterSubs).where(eq(newsletterSubs.unsubscribeTokenHash, unsubscribeTokenHash)).limit(1),
    );
    return rows[0] ?? null;
  }

  async findSendByUnsubscribeToken(token: string): Promise<{ subscriberId: string; email: string } | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ subscriberId: newsletterCampaignSends.subscriberId, email: newsletterCampaignSends.email })
        .from(newsletterCampaignSends)
        .where(eq(newsletterCampaignSends.unsubscribeToken, token))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async markUnsubscribed(input: { subscriberId: string; email: string; via: string }): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(newsletterSubs)
        .set({ status: 'unsubscribed', unsubscribedAt: new Date().toISOString() })
        .where(eq(newsletterSubs.id, input.subscriberId));
      await tx
        .insert(emailSuppressions)
        .values({ email: input.email.toLowerCase(), reason: 'unsubscribe', detail: `one-click (${input.via})` })
        .onConflictDoNothing({ target: emailSuppressions.email });
    });
  }

  async listSubscribers(filter: { status?: string; q?: string; limit?: number; offset?: number }): Promise<{ subscribers: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const like = filter.q ? `%${filter.q.replace(/[%_]/g, '')}%` : null;
    return this.db.withBypass(async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select id, email, status, source, confirmed_at, unsubscribed_at, created_at
        from newsletter_subs
        where (${filter.status ?? null}::varchar is null or status = ${filter.status ?? null})
          and (${like}::varchar is null or email like ${like})
        order by created_at desc
        limit ${limit} offset ${offset}
      `);
      const total = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from newsletter_subs
        where (${filter.status ?? null}::varchar is null or status = ${filter.status ?? null})
          and (${like}::varchar is null or email like ${like})
      `);
      return { subscribers: rows.rows, total: total.rows[0]?.count ?? 0, limit, offset };
    });
  }

  async exportSubscriberRows(): Promise<Array<{ email: string; status: string; confirmedAt: string | null }>> {
    return this.db.withBypass((tx) =>
      tx
        .select({ email: newsletterSubs.email, status: newsletterSubs.status, confirmedAt: newsletterSubs.confirmedAt })
        .from(newsletterSubs)
        .orderBy(desc(newsletterSubs.createdAt))
        .limit(50_000),
    );
  }

  async deleteSubscriberByEmail(email: string): Promise<string | null> {
    const deleted = await this.db.withBypass((tx) =>
      tx.delete(newsletterSubs).where(eq(newsletterSubs.email, email.toLowerCase())).returning({ id: newsletterSubs.id }),
    );
    return deleted[0]?.id ?? null;
  }

  async createCampaign(input: CreateCampaignInput): Promise<NewsletterCampaignRow> {
    const inserted = await this.db.withBypass((tx) =>
      tx
        .insert(newsletterCampaigns)
        .values({ subject: input.subject.slice(0, 512), preheader: input.preheader?.slice(0, 256), bodyMd: input.bodyMd, createdBy: null })
        .returning(),
    );
    return inserted[0];
  }

  async getCampaign(campaignId: string): Promise<NewsletterCampaignRow | null> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(newsletterCampaigns).where(eq(newsletterCampaigns.id, campaignId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async updateCampaign(input: UpdateCampaignInput): Promise<NewsletterCampaignRow | null> {
    const updated = await this.db.withBypass((tx) =>
      tx
        .update(newsletterCampaigns)
        .set({
          ...(input.subject !== undefined ? { subject: input.subject.slice(0, 512) } : {}),
          ...(input.preheader !== undefined ? { preheader: input.preheader?.slice(0, 256) } : {}),
          ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(newsletterCampaigns.id, input.campaignId))
        .returning(),
    );
    return updated[0] ?? null;
  }

  async confirmedRecipients(): Promise<CampaignRecipient[]> {
    const result = await this.db.withBypass((tx) =>
      tx.execute<{ id: string; email: string }>(sql`
        select s.id, s.email from newsletter_subs s
        where s.status = 'confirmed'
          and not exists (select 1 from email_suppressions e where e.email = s.email and e.resolved_at is null)
      `),
    );
    return result.rows;
  }

  async scheduleCampaign(input: { campaignId: string; scheduledAt: string; recipients: CampaignRecipient[]; makeToken: () => string }): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(newsletterCampaigns)
        .set({ status: 'scheduled', scheduledAt: input.scheduledAt, recipientCount: input.recipients.length, updatedAt: new Date().toISOString() })
        .where(eq(newsletterCampaigns.id, input.campaignId));
      for (const row of input.recipients) {
        await tx
          .insert(newsletterCampaignSends)
          .values({ campaignId: input.campaignId, subscriberId: row.id, email: row.email, unsubscribeToken: input.makeToken() })
          .onConflictDoNothing();
      }
    });
  }

  async cancelCampaign(campaignId: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterCampaigns)
        .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
        .where(eq(newsletterCampaigns.id, campaignId)),
    );
  }

  async listCampaigns(): Promise<NewsletterCampaignRow[]> {
    return this.db.withBypass((tx) =>
      tx.select().from(newsletterCampaigns).orderBy(desc(newsletterCampaigns.createdAt)).limit(200),
    );
  }

  async campaignSendCounts(campaignId: string): Promise<Array<{ status: string; count: number }>> {
    const result = await this.db.withBypass((tx) =>
      tx.execute<{ status: string; count: number }>(sql`
        select status, count(*)::int as count from newsletter_campaign_sends where campaign_id = ${campaignId} group by status
      `),
    );
    return result.rows;
  }

  async promoteDueCampaigns(): Promise<void> {
    await this.db.withBypass((tx) =>
      tx.execute(sql`
        update newsletter_campaigns set status = 'sending', updated_at = now()
        where status = 'scheduled' and scheduled_at <= now()
      `),
    );
  }

  async inflightCampaigns(): Promise<string[]> {
    const rows = await this.db.withBypass((tx) =>
      tx.select({ id: newsletterCampaigns.id }).from(newsletterCampaigns).where(eq(newsletterCampaigns.status, 'sending')),
    );
    return rows.map((r) => r.id);
  }

  async queuedSends(campaignId: string, limit: number): Promise<NewsletterCampaignSendRow[]> {
    return this.db.withBypass((tx) =>
      tx
        .select()
        .from(newsletterCampaignSends)
        .where(and(eq(newsletterCampaignSends.campaignId, campaignId), eq(newsletterCampaignSends.status, 'queued')))
        .limit(limit),
    );
  }

  async markSendSent(sendId: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterCampaignSends)
        .set({ status: 'sent', sentAt: new Date().toISOString() })
        .where(eq(newsletterCampaignSends.id, sendId)),
    );
  }

  async markSendFailed(input: { sendId: string; skippedSuppressed: boolean; error: string | null }): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterCampaignSends)
        .set({ status: input.skippedSuppressed ? 'skipped_suppressed' : 'failed', error: input.skippedSuppressed ? null : input.error })
        .where(eq(newsletterCampaignSends.id, input.sendId)),
    );
  }

  async bumpCampaignCounters(input: { campaignId: string; sent?: boolean; failed?: boolean }): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterCampaigns)
        .set({
          ...(input.sent ? { sentCount: sql`${newsletterCampaigns.sentCount} + 1` } : {}),
          ...(input.failed ? { failedCount: sql`${newsletterCampaigns.failedCount} + 1` } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(newsletterCampaigns.id, input.campaignId)),
    );
  }

  async remainingQueuedSends(campaignId: string): Promise<number> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(newsletterCampaignSends)
        .where(and(eq(newsletterCampaignSends.campaignId, campaignId), eq(newsletterCampaignSends.status, 'queued'))),
    );
    return rows[0]?.count ?? 0;
  }

  async completeCampaign(campaignId: string): Promise<void> {
    await this.db.withBypass((tx) =>
      tx
        .update(newsletterCampaigns)
        .set({ status: 'sent', sentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(newsletterCampaigns.id, campaignId)),
    );
  }
}

// Re-export the QueuedSend shape for the service's batch loop.
export type { QueuedSend };
