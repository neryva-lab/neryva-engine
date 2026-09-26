/**
 * Shared MongoDB document shapes + row mappers for the corporate-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 *
 * Corporate tables are GLOBAL (non-tenant, no RLS) — collections are plain
 * `Collection<T>` handles; every repository method runs inside `withBypass`
 * (one majority transaction), matching the pg lane's `withBypass` usage.
 */
import type { Binary, Db, WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type {
  CareerApplicationRow,
  CareerJobRow,
} from './careers.repository';
import type { ContactSubmissionRow } from './contact-inbox.repository';
import type { EmailSuppressionRow } from './suppression.repository';
import type { ContentPostRow, ContentRevisionRow } from './content.repository';
import type {
  NewsletterCampaignRow,
  NewsletterCampaignSendRow,
  NewsletterSubRow,
} from './newsletter.repository';

/** True for MongoDB duplicate-key errors (the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** All corporate-module collections in one handle map (per withBypass unit). */
export function corporateCollections(db: Db) {
  return {
    careerJobs: db.collection<CareerJobMongoDoc>('career_jobs'),
    careerApplications: db.collection<CareerApplicationMongoDoc>('career_applications'),
    contactSubmissions: db.collection<ContactSubmissionMongoDoc>('contact_submissions'),
    emailSuppressions: db.collection<EmailSuppressionMongoDoc>('email_suppressions'),
    contentPosts: db.collection<ContentPostMongoDoc>('content_posts'),
    contentRevisions: db.collection<ContentRevisionMongoDoc>('content_revisions'),
    newsletterSubs: db.collection<NewsletterSubMongoDoc>('newsletter_subs'),
    newsletterCampaigns: db.collection<NewsletterCampaignMongoDoc>('newsletter_campaigns'),
    newsletterCampaignSends: db.collection<NewsletterCampaignSendMongoDoc>('newsletter_campaign_sends'),
    emailDeliveries: db.collection<EmailDeliveryMongoDoc>('email_deliveries'),
    corporateContentStaff: db.collection<CorporateContentStaffMongoDoc>('corporate_content_staff'),
  };
}

export type CorporateCollections = ReturnType<typeof corporateCollections>;

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

function uuidOrNull(value: Binary | null | undefined): string | null {
  return value ? uuidOf(value) : null;
}

// ── career_jobs ─────────────────────────────────────────────────────────────

export interface CareerJobMongoDoc {
  id: Binary;
  slug: string;
  title: string;
  department: string;
  location: string;
  employment_type: string;
  description_md: string;
  apply_instructions: string | null;
  status: string;
  published_at: string | null;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export function toCareerJob(doc: WithId<CareerJobMongoDoc>): CareerJobRow {
  return {
    id: uuidOf(doc.id),
    slug: doc.slug,
    title: doc.title,
    department: doc.department,
    location: doc.location,
    employmentType: doc.employment_type,
    descriptionMd: doc.description_md,
    applyInstructions: doc.apply_instructions,
    status: doc.status,
    publishedAt: doc.published_at,
    createdBy: uuidOrNull(doc.created_by),
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── career_applications ─────────────────────────────────────────────────────

export interface CareerApplicationMongoDoc {
  id: Binary;
  name: string;
  email: string;
  position: string;
  job_id: Binary | null;
  phone: string | null;
  linkedin_url: string | null;
  portfolio_url: string | null;
  cover_note: string | null;
  file_ref: string | null;
  request_ip: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

export function toCareerApplication(doc: WithId<CareerApplicationMongoDoc>): CareerApplicationRow {
  return {
    id: uuidOf(doc.id),
    name: doc.name,
    email: doc.email,
    position: doc.position,
    jobId: uuidOrNull(doc.job_id),
    phone: doc.phone,
    linkedinUrl: doc.linkedin_url,
    portfolioUrl: doc.portfolio_url,
    coverNote: doc.cover_note,
    fileRef: doc.file_ref,
    requestIp: doc.request_ip,
    status: doc.status,
    notes: doc.notes,
    createdAt: doc.created_at,
  };
}

// ── contact_submissions ─────────────────────────────────────────────────────

export interface ContactSubmissionMongoDoc {
  id: Binary;
  name: string;
  email: string;
  company: string | null;
  message: string;
  request_ip: string | null;
  status: string;
  notes: string | null;
  replied_at: string | null;
  opt_in_updates: boolean;
  created_at: string;
}

export function toContactSubmission(doc: WithId<ContactSubmissionMongoDoc>): ContactSubmissionRow {
  return {
    id: uuidOf(doc.id),
    name: doc.name,
    email: doc.email,
    company: doc.company,
    message: doc.message,
    requestIp: doc.request_ip,
    status: doc.status,
    notes: doc.notes,
    repliedAt: doc.replied_at,
    optInUpdates: doc.opt_in_updates,
    createdAt: doc.created_at,
  };
}

// ── email_suppressions ──────────────────────────────────────────────────────

export interface EmailSuppressionMongoDoc {
  id: Binary;
  email: string;
  reason: string;
  detail: string | null;
  resolved_at: string | null;
  created_at: string;
}

export function toEmailSuppression(doc: WithId<EmailSuppressionMongoDoc>): EmailSuppressionRow {
  return {
    id: uuidOf(doc.id),
    email: doc.email,
    reason: doc.reason,
    detail: doc.detail,
    resolvedAt: doc.resolved_at,
    createdAt: doc.created_at,
  };
}

// ── content_posts ───────────────────────────────────────────────────────────

export interface ContentPostMongoDoc {
  id: Binary;
  slug: string;
  title: string;
  summary: string | null;
  body_md: string;
  status: string;
  tags: string[];
  category: string | null;
  seo_description: string | null;
  cover_image: string | null;
  author_name: string | null;
  featured: boolean;
  publish_at: string | null;
  author_account: Binary;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toContentPost(doc: WithId<ContentPostMongoDoc>): ContentPostRow {
  return {
    id: uuidOf(doc.id),
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary,
    bodyMd: doc.body_md,
    status: doc.status,
    tags: doc.tags,
    category: doc.category,
    seoDescription: doc.seo_description,
    coverImage: doc.cover_image,
    authorName: doc.author_name,
    featured: doc.featured,
    publishAt: doc.publish_at,
    authorAccount: uuidOf(doc.author_account),
    publishedAt: doc.published_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── content_revisions ───────────────────────────────────────────────────────

export interface ContentRevisionMongoDoc {
  id: Binary;
  post_id: Binary;
  version: number;
  title: string;
  summary: string | null;
  body_md: string;
  tags: string[];
  editor_account: Binary | null;
  created_at: string;
}

export function toContentRevision(doc: WithId<ContentRevisionMongoDoc>): ContentRevisionRow {
  return {
    id: uuidOf(doc.id),
    postId: uuidOf(doc.post_id),
    version: doc.version,
    title: doc.title,
    summary: doc.summary,
    bodyMd: doc.body_md,
    tags: doc.tags,
    editorAccount: uuidOrNull(doc.editor_account),
    createdAt: doc.created_at,
  };
}

// ── newsletter_subs ─────────────────────────────────────────────────────────

export interface NewsletterSubMongoDoc {
  id: Binary;
  email: string;
  status: string;
  confirm_token_hash: string | null;
  unsubscribe_token_hash: string | null;
  source: string;
  confirmed_ip: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
}

export function toNewsletterSub(doc: WithId<NewsletterSubMongoDoc>): NewsletterSubRow {
  return {
    id: uuidOf(doc.id),
    email: doc.email,
    status: doc.status,
    confirmTokenHash: doc.confirm_token_hash,
    unsubscribeTokenHash: doc.unsubscribe_token_hash,
    source: doc.source,
    confirmedIp: doc.confirmed_ip,
    confirmedAt: doc.confirmed_at,
    unsubscribedAt: doc.unsubscribed_at,
    createdAt: doc.created_at,
  };
}

// ── newsletter_campaigns ────────────────────────────────────────────────────

export interface NewsletterCampaignMongoDoc {
  id: Binary;
  subject: string;
  preheader: string | null;
  body_md: string;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  created_by: Binary | null;
  created_at: string;
  updated_at: string;
}

export function toNewsletterCampaign(doc: WithId<NewsletterCampaignMongoDoc>): NewsletterCampaignRow {
  return {
    id: uuidOf(doc.id),
    subject: doc.subject,
    preheader: doc.preheader,
    bodyMd: doc.body_md,
    status: doc.status,
    scheduledAt: doc.scheduled_at,
    sentAt: doc.sent_at,
    recipientCount: doc.recipient_count,
    sentCount: doc.sent_count,
    failedCount: doc.failed_count,
    createdBy: uuidOrNull(doc.created_by),
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── newsletter_campaign_sends ───────────────────────────────────────────────

export interface NewsletterCampaignSendMongoDoc {
  id: Binary;
  campaign_id: Binary;
  subscriber_id: Binary;
  email: string;
  status: string;
  unsubscribe_token: string;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

export function toNewsletterCampaignSend(doc: WithId<NewsletterCampaignSendMongoDoc>): NewsletterCampaignSendRow {
  return {
    id: uuidOf(doc.id),
    campaignId: uuidOf(doc.campaign_id),
    subscriberId: uuidOf(doc.subscriber_id),
    email: doc.email,
    status: doc.status,
    unsubscribeToken: doc.unsubscribe_token,
    error: doc.error,
    sentAt: doc.sent_at,
    createdAt: doc.created_at,
  };
}

// ── email_deliveries ────────────────────────────────────────────────────────

export interface EmailDeliveryMongoDoc {
  id: Binary;
  template: string;
  recipient: string;
  subject: string;
  transport: string;
  status: string;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ── corporate_content_staff ─────────────────────────────────────────────────

export interface CorporateContentStaffMongoDoc {
  account_id: Binary;
  granted_by: Binary;
  granted_at: string;
}
