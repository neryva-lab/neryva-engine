-- eng-0003: corporate public plane (E-2/E-3) — platform-plane tables
-- (no RLS, like accounts: submitters are plain rows, never tenants).

CREATE TABLE contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(256) NOT NULL,
  email varchar(320) NOT NULL,
  company varchar(256),
  message text NOT NULL,
  request_ip varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_contact_submissions_created ON contact_submissions (created_at);

CREATE TABLE newsletter_subs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  confirm_token_hash varchar(64),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_newsletter_subs_email ON newsletter_subs (email);

CREATE TABLE career_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(256) NOT NULL,
  email varchar(320) NOT NULL,
  position varchar(256) NOT NULL,
  portfolio_url varchar(1024),
  cover_note text,
  file_ref varchar(1024),
  request_ip varchar(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_career_applications_created ON career_applications (created_at);

CREATE TABLE content_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(256) NOT NULL,
  title varchar(512) NOT NULL,
  summary varchar(1024),
  body_md text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_account uuid NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_content_posts_slug ON content_posts (slug);

CREATE TABLE corporate_content_staff (
  account_id uuid PRIMARY KEY,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
