-- eng-0013: corporate depth (E-1/E-2/E-3 to production grade): inbox and
-- recruiting pipelines, job postings, newsletter unsubscribe tokens +
-- campaigns + per-recipient sends, the email suppression list, and the
-- content CMS upgrade (revisions, SEO, scheduling). Additive columns only
-- — no destructive changes to eng-0003's tables.

-- ── E-2: pipelines ──────────────────────────────────────────────────────────
ALTER TABLE contact_submissions ADD COLUMN status varchar(16) NOT NULL DEFAULT 'new';
ALTER TABLE contact_submissions ADD COLUMN notes text;
ALTER TABLE contact_submissions ADD COLUMN replied_at timestamptz;
ALTER TABLE contact_submissions ADD COLUMN opt_in_updates boolean NOT NULL DEFAULT false;
CREATE INDEX ix_contact_submissions_status ON contact_submissions (status, created_at);

ALTER TABLE newsletter_subs ADD COLUMN unsubscribe_token_hash varchar(64);
ALTER TABLE newsletter_subs ADD COLUMN source varchar(32) NOT NULL DEFAULT 'website';
ALTER TABLE newsletter_subs ADD COLUMN confirmed_ip varchar(64);
CREATE INDEX ix_newsletter_subs_status ON newsletter_subs (status);

CREATE TABLE career_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(256) NOT NULL,
  title varchar(256) NOT NULL,
  department varchar(128) NOT NULL,
  location varchar(128) NOT NULL,
  employment_type varchar(32) NOT NULL DEFAULT 'full_time',
  description_md text NOT NULL,
  apply_instructions varchar(1024),
  status varchar(16) NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_career_jobs_slug ON career_jobs (slug);
CREATE INDEX ix_career_jobs_status ON career_jobs (status);

ALTER TABLE career_applications ADD COLUMN job_id uuid;
ALTER TABLE career_applications ADD COLUMN phone varchar(64);
ALTER TABLE career_applications ADD COLUMN linkedin_url varchar(1024);
ALTER TABLE career_applications ADD COLUMN status varchar(16) NOT NULL DEFAULT 'new';
ALTER TABLE career_applications ADD COLUMN notes text;
CREATE INDEX ix_career_applications_status ON career_applications (status, created_at);

-- ── E-3: content CMS depth ──────────────────────────────────────────────────
ALTER TABLE content_posts ADD COLUMN category varchar(64);
ALTER TABLE content_posts ADD COLUMN seo_description varchar(512);
ALTER TABLE content_posts ADD COLUMN cover_image varchar(1024);
ALTER TABLE content_posts ADD COLUMN author_name varchar(256);
ALTER TABLE content_posts ADD COLUMN featured boolean NOT NULL DEFAULT false;
ALTER TABLE content_posts ADD COLUMN publish_at timestamptz;
CREATE INDEX ix_content_posts_status_published ON content_posts (status, published_at);

CREATE TABLE content_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  version integer NOT NULL,
  title varchar(512) NOT NULL,
  summary varchar(1024),
  body_md text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  editor_account uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_content_revisions_post_version ON content_revisions (post_id, version);

-- ── E-1: email infrastructure ───────────────────────────────────────────────
CREATE TABLE newsletter_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject varchar(512) NOT NULL,
  preheader varchar(256),
  body_md text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_newsletter_campaigns_status ON newsletter_campaigns (status, scheduled_at);

CREATE TABLE newsletter_campaign_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  subscriber_id uuid NOT NULL,
  email varchar(320) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  unsubscribe_token varchar(128) NOT NULL,
  error varchar(512),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_campaign_sends ON newsletter_campaign_sends (campaign_id, subscriber_id);
CREATE INDEX ix_campaign_sends_pending ON newsletter_campaign_sends (campaign_id, status);

CREATE TABLE email_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  reason varchar(32) NOT NULL,              -- hard_bounce | complaint | unsubscribe | manual
  detail varchar(512),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_email_suppressions_email ON email_suppressions (email);
