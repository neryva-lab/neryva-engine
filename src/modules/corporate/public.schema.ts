import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/**
 * Corporate public-plane tables (corporate E-2/E-3, eng-0003).
 * Platform-plane like accounts: NOT tenant-scoped, no RLS — the engine is
 * the only writer; submitters are plain rows, never accounts (ADR-004 D4).
 */

export const contactSubmissions = pgTable('contact_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 256 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  company: varchar('company', { length: 256 }),
  message: text('message').notNull(),
  requestIp: varchar('request_ip', { length: 64 }),
  // Inbox pipeline (the reference backend's model): new -> read -> replied -> archived.
  status: varchar('status', { length: 16 }).notNull().default('new'),
  notes: text('notes'),
  repliedAt: timestamp('replied_at', { withTimezone: true, mode: 'string' }),
  optInUpdates: boolean('opt_in_updates').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_contact_submissions_created').on(t.createdAt), index('ix_contact_submissions_status').on(t.status, t.createdAt)]);

/**
 * Newsletter double opt-in: `pending` until the emailed confirmation token
 * is redeemed; `confirmed` from then on. The token is stored hashed and is
 * single-use. A re-subscribe of a confirmed address is a no-op (idempotent
 * by the unique email index).
 */
export const newsletterSubs = pgTable('newsletter_subs', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'), // pending | confirmed | unsubscribed
  confirmTokenHash: varchar('confirm_token_hash', { length: 64 }),
  // Per-subscriber unsubscribe token (stable while subscribed; one-click + List-Unsubscribe).
  unsubscribeTokenHash: varchar('unsubscribe_token_hash', { length: 64 }),
  source: varchar('source', { length: 32 }).notNull().default('website'),
  confirmedIp: varchar('confirmed_ip', { length: 64 }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_newsletter_subs_email').on(t.email), index('ix_newsletter_subs_status').on(t.status)]);

/** Job postings (the careers page's content): draft -> published -> archived. */
export const careerJobs = pgTable('career_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 256 }).notNull(),
  title: varchar('title', { length: 256 }).notNull(),
  department: varchar('department', { length: 128 }).notNull(),
  location: varchar('location', { length: 128 }).notNull(),
  // full_time | part_time | contract | internship
  employmentType: varchar('employment_type', { length: 32 }).notNull().default('full_time'),
  descriptionMd: text('description_md').notNull(),
  applyInstructions: varchar('apply_instructions', { length: 1024 }),
  status: varchar('status', { length: 16 }).notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_career_jobs_slug').on(t.slug), index('ix_career_jobs_status').on(t.status)]);

/** Career applications: file REFERENCES only — object storage paths, never blobs in Postgres. */
export const careerApplications = pgTable('career_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 256 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  position: varchar('position', { length: 256 }).notNull(),
  jobId: uuid('job_id'),
  phone: varchar('phone', { length: 64 }),
  linkedinUrl: varchar('linkedin_url', { length: 1024 }),
  portfolioUrl: varchar('portfolio_url', { length: 1024 }),
  coverNote: text('cover_note'),
  fileRef: varchar('file_ref', { length: 1024 }),
  requestIp: varchar('request_ip', { length: 64 }),
  // Recruiting pipeline: new -> reviewed -> interviewed -> offered | rejected | withdrawn.
  status: varchar('status', { length: 16 }).notNull().default('new'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_career_applications_created').on(t.createdAt), index('ix_career_applications_status').on(t.status, t.createdAt)]);

/** Blog/content posts (E-3): staff-authored; the website renders statically from the export feed. */
export const contentPosts = pgTable('content_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 256 }).notNull(),
  title: varchar('title', { length: 512 }).notNull(),
  summary: varchar('summary', { length: 1024 }),
  bodyMd: text('body_md').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'), // draft | published | archived
  tags: jsonb('tags').notNull().default([]),
  category: varchar('category', { length: 64 }),
  seoDescription: varchar('seo_description', { length: 512 }),
  coverImage: varchar('cover_image', { length: 1024 }),
  authorName: varchar('author_name', { length: 256 }),
  featured: boolean('featured').notNull().default(false),
  // Scheduled publishing: when set (future) the worker publishes at the instant.
  publishAt: timestamp('publish_at', { withTimezone: true, mode: 'string' }),
  authorAccount: uuid('author_account').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_content_posts_slug').on(t.slug), index('ix_content_posts_status_published').on(t.status, t.publishedAt)]);

/** Post revisions: an immutable snapshot per save — restore is a first-class action. */
export const contentRevisions = pgTable('content_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull(),
  version: integer('version').notNull(),
  title: varchar('title', { length: 512 }).notNull(),
  summary: varchar('summary', { length: 1024 }),
  bodyMd: text('body_md').notNull(),
  tags: jsonb('tags').notNull().default([]),
  editorAccount: uuid('editor_account'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_content_revisions_post_version').on(t.postId, t.version)]);

/** Content-staff grants: who may author/edit content (the old website admin/editor roles, reborn). */
export const corporateContentStaff = pgTable('corporate_content_staff', {
  accountId: uuid('account_id').primaryKey(),
  grantedBy: uuid('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

/**
 * Newsletter campaigns: staff-authored broadcasts. draft -> scheduled (at)
 * -> sending (worker-driven, resumable) -> sent | cancelled. Every
 * recipient gets a per-campaign send row (dedupe + resume + suppression
 * record).
 */
export const newsletterCampaigns = pgTable('newsletter_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  subject: varchar('subject', { length: 512 }).notNull(),
  preheader: varchar('preheader', { length: 256 }),
  bodyMd: text('body_md').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'), // draft | scheduled | sending | sent | cancelled
  scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'string' }),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
  recipientCount: integer('recipient_count').notNull().default(0),
  sentCount: integer('sent_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_newsletter_campaigns_status').on(t.status, t.scheduledAt)]);

export const newsletterCampaignSends = pgTable('newsletter_campaign_sends', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull(),
  subscriberId: uuid('subscriber_id').notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('queued'), // queued | sent | failed | skipped_suppressed
  /** Per-send unsubscribe token (RAW — it only ever unsubscribes its own subscriber). */
  unsubscribeToken: varchar('unsubscribe_token', { length: 128 }).notNull(),
  error: varchar('error', { length: 512 }),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_campaign_sends').on(t.campaignId, t.subscriberId), index('ix_campaign_sends_pending').on(t.campaignId, t.status)]);

/**
 * The suppression list: hard bounces, spam complaints, manual holds. The
 * email service refuses to send to suppressed addresses (recorded as a
 * skipped delivery) — sender reputation is a platform asset.
 */
export const emailSuppressions = pgTable('email_suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull(),
  // hard_bounce | complaint | unsubscribe | manual
  reason: varchar('reason', { length: 32 }).notNull(),
  detail: varchar('detail', { length: 512 }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_email_suppressions_email').on(t.email)]);

