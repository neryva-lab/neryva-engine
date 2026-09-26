/**
 * MongoDB lane for `INewsletterRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * every method is one `withBypass` unit with plain collection handles.
 *
 * `scheduleCampaign` keeps the original single-transaction boundary
 * (campaign flip + queued send rows). The per-(campaign, subscriber)
 * idempotency uses an atomic upsert (= the pg lane's onConflictDoNothing).
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  CampaignRecipient,
  CreateCampaignInput,
  INewsletterRepository,
  NewsletterCampaignRow,
  NewsletterCampaignSendRow,
  NewsletterSubRow,
  UpdateCampaignInput,
  UpsertSubscriberInput,
} from './newsletter.repository';
import {
  binUuid,
  corporateCollections,
  isDuplicateKey,
  toNewsletterCampaign,
  toNewsletterCampaignSend,
  toNewsletterSub,
} from './mongo-documents';

export class MongoNewsletterRepository implements INewsletterRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...corporateCollections(db) };
  }

  async getSubscriberByEmail(email: string): Promise<NewsletterSubRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.newsletterSubs.findOne({ email }, t.session);
      return doc ? toNewsletterSub(doc) : null;
    });
  }

  async insertPendingSubscriber(input: UpsertSubscriberInput): Promise<{ id: string } | null> {
    const db = this.mongo.root;
    try {
      return await this.mongo.withBypass(async (ctx) => {
        const t = this.tx(db, ctx);
        const id = binUuid(uuidv7());
        await t.newsletterSubs.insertOne(
          {
            id,
            email: input.email,
            status: 'pending',
            confirm_token_hash: input.confirmTokenHash,
            unsubscribe_token_hash: input.unsubscribeTokenHash,
            source: input.source,
            confirmed_ip: null,
            confirmed_at: null,
            unsubscribed_at: null,
            created_at: new Date().toISOString(),
          },
          t.session,
        );
        return { id: id.toUUID().toString() };
      });
    } catch (err) {
      // Insert race lost (= the pg lane's onConflictDoNothing returning no
      // row): signal the caller to take the refresh path. No reads in the
      // aborted transaction.
      if (isDuplicateKey(err)) {
        return null;
      }
      throw err as Error;
    }
  }

  async refreshPendingSubscriber(input: { id: string; confirmTokenHash: string; unsubscribeTokenHash: string; source: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterSubs.updateOne(
        { id: binUuid(input.id, 'id') },
        {
          $set: {
            status: 'pending',
            confirm_token_hash: input.confirmTokenHash,
            unsubscribe_token_hash: input.unsubscribeTokenHash,
            source: input.source,
            unsubscribed_at: null,
          },
        },
        t.session,
      );
    });
  }

  async refreshConfirmToken(email: string, confirmTokenHash: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterSubs.updateOne(
        { email, status: 'pending' },
        { $set: { confirm_token_hash: confirmTokenHash } },
        t.session,
      );
    });
  }

  async findPendingByConfirmTokenHash(confirmTokenHash: string): Promise<NewsletterSubRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.newsletterSubs.findOne(
        { confirm_token_hash: confirmTokenHash, status: 'pending' },
        t.session,
      );
      return doc ? toNewsletterSub(doc) : null;
    });
  }

  async confirmSubscriber(input: { id: string; ip: string | null }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterSubs.updateOne(
        { id: binUuid(input.id, 'id') },
        {
          $set: {
            status: 'confirmed',
            confirmed_at: new Date().toISOString(),
            confirmed_ip: input.ip,
            confirm_token_hash: null,
          },
        },
        t.session,
      );
    });
  }

  async findByUnsubscribeTokenHash(unsubscribeTokenHash: string): Promise<NewsletterSubRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.newsletterSubs.findOne({ unsubscribe_token_hash: unsubscribeTokenHash }, t.session);
      return doc ? toNewsletterSub(doc) : null;
    });
  }

  async findSendByUnsubscribeToken(token: string): Promise<{ subscriberId: string; email: string } | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.newsletterCampaignSends.findOne(
        { unsubscribe_token: token },
        { ...t.session, projection: { subscriber_id: 1, email: 1 } },
      );
      return doc ? { subscriberId: doc.subscriber_id.toUUID().toString(), email: doc.email } : null;
    });
  }

  async markUnsubscribed(input: { subscriberId: string; email: string; via: string }): Promise<void> {
    const db = this.mongo.root;
    const email = input.email.toLowerCase();
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterSubs.updateOne(
        { id: binUuid(input.subscriberId, 'subscriberId') },
        { $set: { status: 'unsubscribed', unsubscribed_at: new Date().toISOString() } },
        t.session,
      );
      await t.emailSuppressions.updateOne(
        { email },
        {
          $setOnInsert: {
            id: binUuid(uuidv7()),
            email,
            reason: 'unsubscribe',
            detail: `one-click (${input.via})`,
            resolved_at: null,
            created_at: new Date().toISOString(),
          },
        },
        { ...t.session, upsert: true },
      );
    });
  }

  async listSubscribers(filter: { status?: string; q?: string; limit?: number; offset?: number }): Promise<{ subscribers: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const db = this.mongo.root;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const match: Record<string, unknown> = {};
      if (filter.status) {
        match['status'] = filter.status;
      }
      if (filter.q) {
        const raw = filter.q.replace(/[%_]/g, '');
        const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        match['email'] = { $regex: escaped };
      }
      const total = await t.newsletterSubs.countDocuments(match, t.session);
      const docs = await t.newsletterSubs
        .find(match, t.session)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      const subscribers = docs.map((d) => ({
        id: d.id.toUUID().toString(),
        email: d.email,
        status: d.status,
        source: d.source,
        confirmed_at: d.confirmed_at,
        unsubscribed_at: d.unsubscribed_at,
        created_at: d.created_at,
      }));
      return { subscribers, total, limit, offset };
    });
  }

  async exportSubscriberRows(): Promise<Array<{ email: string; status: string; confirmedAt: string | null }>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.newsletterSubs
        .find({}, t.session)
        .sort({ created_at: -1 })
        .limit(50_000)
        .toArray();
      return docs.map((d) => ({ email: d.email, status: d.status, confirmedAt: d.confirmed_at }));
    });
  }

  async deleteSubscriberByEmail(email: string): Promise<string | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const deleted = await t.newsletterSubs.findOneAndDelete(
        { email: email.toLowerCase() },
        { ...t.session, projection: { id: 1 } },
      );
      return deleted ? deleted.id.toUUID().toString() : null;
    });
  }

  async createCampaign(input: CreateCampaignInput): Promise<NewsletterCampaignRow> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = {
        id: binUuid(uuidv7()),
        subject: input.subject.slice(0, 512),
        preheader: input.preheader?.slice(0, 256) ?? null,
        body_md: input.bodyMd,
        status: 'draft',
        scheduled_at: null,
        sent_at: null,
        recipient_count: 0,
        sent_count: 0,
        failed_count: 0,
        created_by: null,
        created_at: now,
        updated_at: now,
      };
      await t.newsletterCampaigns.insertOne(doc, t.session);
      return toNewsletterCampaign({ ...doc, _id: undefined as never });
    });
  }

  async getCampaign(campaignId: string): Promise<NewsletterCampaignRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.newsletterCampaigns.findOne({ id: binUuid(campaignId, 'campaignId') }, t.session);
      return doc ? toNewsletterCampaign(doc) : null;
    });
  }

  async updateCampaign(input: UpdateCampaignInput): Promise<NewsletterCampaignRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (input.subject !== undefined) {
        update['subject'] = input.subject.slice(0, 512);
      }
      if (input.preheader !== undefined) {
        update['preheader'] = input.preheader?.slice(0, 256) ?? null;
      }
      if (input.bodyMd !== undefined) {
        update['body_md'] = input.bodyMd;
      }
      const updated = await t.newsletterCampaigns.findOneAndUpdate(
        { id: binUuid(input.campaignId, 'campaignId') },
        { $set: update },
        { ...t.session, returnDocument: 'after' },
      );
      return updated ? toNewsletterCampaign(updated) : null;
    });
  }

  async confirmedRecipients(): Promise<CampaignRecipient[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // The pg NOT EXISTS (unresolved suppression) becomes an in-txn
      // anti-join: confirmed subs minus suppressed emails.
      const subs = await t.newsletterSubs
        .find({ status: 'confirmed' }, { ...t.session, projection: { id: 1, email: 1 } })
        .toArray();
      if (subs.length === 0) {
        return [];
      }
      const suppressed = await t.emailSuppressions
        .find(
          { email: { $in: subs.map((s) => s.email) }, resolved_at: null },
          { ...t.session, projection: { email: 1 } },
        )
        .toArray();
      const suppressedSet = new Set(suppressed.map((s) => s.email));
      return subs
        .filter((s) => !suppressedSet.has(s.email))
        .map((s) => ({ id: s.id.toUUID().toString(), email: s.email }));
    });
  }

  async scheduleCampaign(input: { campaignId: string; scheduledAt: string; recipients: CampaignRecipient[]; makeToken: () => string }): Promise<void> {
    const db = this.mongo.root;
    const campaignId = binUuid(input.campaignId, 'campaignId');
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterCampaigns.updateOne(
        { id: campaignId },
        {
          $set: {
            status: 'scheduled',
            scheduled_at: input.scheduledAt,
            recipient_count: input.recipients.length,
            updated_at: new Date().toISOString(),
          },
        },
        t.session,
      );
      for (const row of input.recipients) {
        // Atomic upsert = the pg lane's onConflictDoNothing on
        // (campaign_id, subscriber_id): a crashed schedule resumes exactly.
        await t.newsletterCampaignSends.updateOne(
          { campaign_id: campaignId, subscriber_id: binUuid(row.id, 'subscriberId') },
          {
            $setOnInsert: {
              id: binUuid(uuidv7()),
              campaign_id: campaignId,
              subscriber_id: binUuid(row.id, 'subscriberId'),
              email: row.email,
              status: 'queued',
              unsubscribe_token: input.makeToken(),
              error: null,
              sent_at: null,
              created_at: new Date().toISOString(),
            },
          },
          { ...t.session, upsert: true },
        );
      }
    });
  }

  async cancelCampaign(campaignId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterCampaigns.updateOne(
        { id: binUuid(campaignId, 'campaignId') },
        { $set: { status: 'cancelled', updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async listCampaigns(): Promise<NewsletterCampaignRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.newsletterCampaigns.find({}, t.session).sort({ created_at: -1 }).limit(200).toArray();
      return docs.map(toNewsletterCampaign);
    });
  }

  async campaignSendCounts(campaignId: string): Promise<Array<{ status: string; count: number }>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.newsletterCampaignSends
        .aggregate(
          [
            { $match: { campaign_id: binUuid(campaignId, 'campaignId') } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ],
          t.session,
        )
        .toArray();
      return docs.map((d) => ({ status: (d as { _id: string })._id, count: (d as { count: number }).count }));
    });
  }

  async promoteDueCampaigns(): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterCampaigns.updateMany(
        { status: 'scheduled', scheduled_at: { $lte: new Date().toISOString() } },
        { $set: { status: 'sending', updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async inflightCampaigns(): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.newsletterCampaigns
        .find({ status: 'sending' }, { ...t.session, projection: { id: 1 } })
        .toArray();
      return docs.map((d) => d.id.toUUID().toString());
    });
  }

  async queuedSends(campaignId: string, limit: number): Promise<NewsletterCampaignSendRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.newsletterCampaignSends
        .find({ campaign_id: binUuid(campaignId, 'campaignId'), status: 'queued' }, t.session)
        .limit(limit)
        .toArray();
      return docs.map(toNewsletterCampaignSend);
    });
  }

  async markSendSent(sendId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterCampaignSends.updateOne(
        { id: binUuid(sendId, 'sendId') },
        { $set: { status: 'sent', sent_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async markSendFailed(input: { sendId: string; skippedSuppressed: boolean; error: string | null }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterCampaignSends.updateOne(
        { id: binUuid(input.sendId, 'sendId') },
        {
          $set: {
            status: input.skippedSuppressed ? 'skipped_suppressed' : 'failed',
            error: input.skippedSuppressed ? null : input.error,
          },
        },
        t.session,
      );
    });
  }

  async bumpCampaignCounters(input: { campaignId: string; sent?: boolean; failed?: boolean }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const inc: Record<string, number> = {};
      if (input.sent) {
        inc['sent_count'] = 1;
      }
      if (input.failed) {
        inc['failed_count'] = 1;
      }
      await t.newsletterCampaigns.updateOne(
        { id: binUuid(input.campaignId, 'campaignId') },
        { $inc: inc, $set: { updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async remainingQueuedSends(campaignId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      return t.newsletterCampaignSends.countDocuments(
        { campaign_id: binUuid(campaignId, 'campaignId'), status: 'queued' },
        t.session,
      );
    });
  }

  async completeCampaign(campaignId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.newsletterCampaigns.updateOne(
        { id: binUuid(campaignId, 'campaignId') },
        { $set: { status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }
}
