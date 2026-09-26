/**
 * Newsletter repository port (P3) — `newsletter_subs` +
 * `newsletter_campaigns` + `newsletter_campaign_sends`.
 *
 * CORPORATE TABLES ARE GLOBAL (non-tenant): per `public.schema.ts`, the
 * corporate plane is "Platform-plane like accounts: NOT tenant-scoped, no
 * RLS — the engine is the only writer". No orgId on these methods by design.
 *
 * No DbService/Drizzle/Mongo types — plain domain types only.
 */
/** Plain domain view of a `newsletter_subs` row (drizzle-free). */
export interface NewsletterSubRow {
  id: string;
  email: string;
  status: string;
  confirmTokenHash: string | null;
  unsubscribeTokenHash: string | null;
  source: string;
  confirmedIp: string | null;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
}

/** Plain domain view of a `newsletter_campaigns` row (drizzle-free). */
export interface NewsletterCampaignRow {
  id: string;
  subject: string;
  preheader: string | null;
  bodyMd: string;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Plain domain view of a `newsletter_campaign_sends` row (drizzle-free). */
export interface NewsletterCampaignSendRow {
  id: string;
  campaignId: string;
  subscriberId: string;
  email: string;
  status: string;
  unsubscribeToken: string;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface UpsertSubscriberInput {
  email: string;
  confirmTokenHash: string;
  unsubscribeTokenHash: string;
  source: string;
}

export interface CreateCampaignInput {
  subject: string;
  preheader?: string;
  bodyMd: string;
}

export interface UpdateCampaignInput {
  campaignId: string;
  subject?: string;
  preheader?: string;
  bodyMd?: string;
}

export interface CampaignRecipient {
  id: string;
  email: string;
}

export interface QueuedSend {
  id: string;
  email: string;
  subscriberId: string;
  unsubscribeToken: string;
}

export interface INewsletterRepository {
  // ── subscriber lifecycle ──────────────────────────────────────────────
  /** Find a subscriber by email; null when unknown. */
  getSubscriberByEmail(email: string): Promise<NewsletterSubRow | null>;
  /** Insert a pending subscriber; on email conflict returns null (race → caller refreshes). */
  insertPendingSubscriber(input: UpsertSubscriberInput): Promise<{ id: string } | null>;
  /** Refresh an existing subscriber back to pending with new tokens. */
  refreshPendingSubscriber(input: { id: string; confirmTokenHash: string; unsubscribeTokenHash: string; source: string }): Promise<void>;
  /** Refresh only the confirm token on a pending row (insert-race path). */
  refreshConfirmToken(email: string, confirmTokenHash: string): Promise<void>;
  /** Find a pending subscriber by confirm-token hash; null when unknown. */
  findPendingByConfirmTokenHash(confirmTokenHash: string): Promise<NewsletterSubRow | null>;
  /** Confirm a subscriber (pending → confirmed, single-use token). */
  confirmSubscriber(input: { id: string; ip: string | null }): Promise<void>;
  /** Find a subscriber by unsubscribe-token hash; null when unknown. */
  findByUnsubscribeTokenHash(unsubscribeTokenHash: string): Promise<NewsletterSubRow | null>;
  /** Find a campaign send by its raw per-send token; null when unknown. */
  findSendByUnsubscribeToken(token: string): Promise<{ subscriberId: string; email: string } | null>;
  /**
   * Mark unsubscribed + insert the suppression row (the hard no-more-mail
   * guarantee) — both writes, same as the original service.
   */
  markUnsubscribed(input: { subscriberId: string; email: string; via: string }): Promise<void>;
  /** Staff: filtered subscriber list with total count. */
  listSubscribers(filter: { status?: string; q?: string; limit?: number; offset?: number }): Promise<{ subscribers: Record<string, unknown>[]; total: number; limit: number; offset: number }>;
  /** Staff: subscriber export rows (email, status, confirmed_at). */
  exportSubscriberRows(): Promise<Array<{ email: string; status: string; confirmedAt: string | null }>>;
  /** Delete a subscriber by email; returns the deleted id or null. */
  deleteSubscriberByEmail(email: string): Promise<string | null>;
  // ── campaigns ─────────────────────────────────────────────────────────
  /** Insert a draft campaign. */
  createCampaign(input: CreateCampaignInput): Promise<NewsletterCampaignRow>;
  /** Get a campaign; null when unknown. */
  getCampaign(campaignId: string): Promise<NewsletterCampaignRow | null>;
  /** Update a draft campaign. */
  updateCampaign(input: UpdateCampaignInput): Promise<NewsletterCampaignRow | null>;
  /** Confirmed, non-suppressed recipients for scheduling. */
  confirmedRecipients(): Promise<CampaignRecipient[]>;
  /**
   * Schedule: flip campaign to scheduled + insert queued send rows
   * (idempotent per campaign+subscriber) — ONE transaction, same as the
   * original `db.root.transaction` block.
   */
  scheduleCampaign(input: { campaignId: string; scheduledAt: string; recipients: CampaignRecipient[]; makeToken: () => string }): Promise<void>;
  /** Cancel a scheduled/sending campaign. */
  cancelCampaign(campaignId: string): Promise<void>;
  /** Staff: all campaigns, newest first. */
  listCampaigns(): Promise<NewsletterCampaignRow[]>;
  /** Send-status counts grouped by status for a campaign. */
  campaignSendCounts(campaignId: string): Promise<Array<{ status: string; count: number }>>;
  /** Worker: promote due scheduled campaigns to sending. */
  promoteDueCampaigns(): Promise<void>;
  /** Worker: in-flight (sending) campaign ids. */
  inflightCampaigns(): Promise<string[]>;
  /** Worker: one throttled batch of queued sends for a campaign. */
  queuedSends(campaignId: string, limit: number): Promise<NewsletterCampaignSendRow[]>;
  /** Worker: mark a send delivered. */
  markSendSent(sendId: string): Promise<void>;
  /** Worker: mark a send failed/skipped. */
  markSendFailed(input: { sendId: string; skippedSuppressed: boolean; error: string | null }): Promise<void>;
  /** Worker: increment campaign sent/failed counters. */
  bumpCampaignCounters(input: { campaignId: string; sent?: boolean; failed?: boolean }): Promise<void>;
  /** Worker: remaining queued sends for a campaign. */
  remainingQueuedSends(campaignId: string): Promise<number>;
  /** Worker: flip a drained campaign to sent. */
  completeCampaign(campaignId: string): Promise<void>;
}
