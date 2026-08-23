import { index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_contact_submissions_created').on(t.createdAt)]);

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
  confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_newsletter_subs_email').on(t.email)]);

/** Career applications: file REFERENCES only — object storage paths, never blobs in Postgres. */
export const careerApplications = pgTable('career_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 256 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  position: varchar('position', { length: 256 }).notNull(),
  portfolioUrl: varchar('portfolio_url', { length: 1024 }),
  coverNote: text('cover_note'),
  fileRef: varchar('file_ref', { length: 1024 }),
  requestIp: varchar('request_ip', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_career_applications_created').on(t.createdAt)]);

/** Blog/content posts (E-3): staff-authored; the website renders statically from the export feed. */
export const contentPosts = pgTable('content_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 256 }).notNull(),
  title: varchar('title', { length: 512 }).notNull(),
  summary: varchar('summary', { length: 1024 }),
  bodyMd: text('body_md').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('draft'), // draft | published | archived
  tags: jsonb('tags').notNull().default([]),
  authorAccount: uuid('author_account').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_content_posts_slug').on(t.slug)]);

/** Content-staff grants: who may author/edit content (the old website admin/editor roles, reborn). */
export const corporateContentStaff = pgTable('corporate_content_staff', {
  accountId: uuid('account_id').primaryKey(),
  grantedBy: uuid('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
