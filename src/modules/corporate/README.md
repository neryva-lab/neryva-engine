# corporate (`src/modules/corporate`)

**Purpose:** ADR-004 D3 — the engine's corporate module. No Express code is
ported (ADR-007 D3). Phases shipped:

- **E-1 (email):** the email service — a platform facility (identity login
  codes and org invites send through it). Transports: file (dev), Resend,
  Postmark, none. Every send is rate-limited, audited as a delivery row.
- **E-2 (public forms):** `POST /public/{contact,newsletter,careers}` and
  `GET /public/newsletter/confirm` — the ONLY unauthenticated routes on the
  engine: per-IP token buckets, `Idempotency-Key` on every POST, strict
  DTO whitelisting (the honeypot `company_url` is rejected by the whitelist
  with an indistinguishable success response), `corporate.submission` audit
  rows. Newsletter is double opt-in (hashed single-use token).
- **E-3 (content):** `/console/content/posts/**` for content staff
  (`corporate_content_staff` grants; L1 + grant), staff-grant management
  operator-only (L2 super_admin), and the `/public/blog` export feed the
  website build syncs from.

**Remaining (P6, other steps):** website re-point, Mongo→Postgres data
migration, neryva_backend retirement.

**Routes:** `/public/**` (none; rate-limited + honeypot + idempotency),
`/console/content/**` (L1 + staff grant; grants L2 super_admin).

**Tables (engine-owned, eng-0001 + eng-0003, platform-plane — no RLS):**
email_deliveries, contact_submissions, newsletter_subs,
career_applications, content_posts, corporate_content_staff.

**Flag:** `MODULES__CORPORATE_ENABLED` (on by default; required by identity).

**Public interface:** `EmailService.sendTemplate(...)`, `ContentService`.
