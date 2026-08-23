# corporate (`src/modules/corporate`)

**Purpose:** neryva.com's duties (ADR-004 D3) at production grade — the
email facility, the public forms with full pipelines, and the content CMS.
No Express code is ported (ADR-007 D3); the reference implementation's
behaviors (contact inbox statuses, the application pipeline, structured
SEO'd posts) are absorbed AND extended.

**Routes:** `/public/**` (rate-limited, honeypot-by-whitelist, idempotent) ·
`/console/content/**` + `/console/corporate/**` (L1 + content-staff grant;
grant management operator-only L2).

**Surfaces (v2):**
- **Email (E-1):** transport port (file/resend/postmark) + template registry +
  delivery audit + **suppression list** (hard bounces/complaints/unsubscribes;
  provider webhooks at `POST /public/email/webhook`, secret-authenticated;
  suppressed addresses are never mailed) + **List-Unsubscribe + RFC 8058
  one-click** headers on bulk mail.
- **Contact (E-2):** acknowledgment email + team notification
  (`CORPORATE_CONTACT_INBOX_EMAIL`) + link heuristics; staff pipeline
  new→read→replied→archived with notes (validated transitions, audited);
  `opt_in_updates` hands off to the newsletter DOUBLE opt-in.
- **Newsletter (E-2):** double opt-in, per-subscriber hashed unsubscribe
  tokens, **one-click unsubscribe** (GET+POST; both footer and per-campaign
  tokens), resubscribe; staff list/filter/CSV export/GDPR export+erasure.
- **Campaigns:** draft→scheduled→sending→sent|cancelled; recipient snapshot
  at schedule (confirmed + non-suppressed) with per-send unsubscribe tokens;
  the worker sends in throttled 50-recipient batches — resumable (unique per
  campaign+subscriber), suppression-aware, self-draining.
- **Careers (E-2):** managed job postings (draft→published→archived; public
  `GET /public/careers/jobs`) + applications with acknowledgment and the
  new→reviewed→interviewed→offered|rejected|withdrawn pipeline (validated
  transitions, notes, filters).
- **Content (E-3):** posts with SEO/category/featured/cover/author; immutable
  **revisions on every save + restore** (history never rewrites); scheduled
  publishing (worker); unpublish-to-draft; draft preview; the static-site
  export bundle; public reading endpoints; **RSS 2.0 + Atom + JSON Feed +
  posts sitemap** (spec-correct escaping/dates).
- **Worker:** `corporate:` namespace — 5-minute maintenance scan (scheduled
  publishes + campaign promotion) with fast self-drain while a campaign is
  mid-flight.

**Tables (eng-0001 + eng-0003 + eng-0013, platform-plane — no RLS):**
email_deliveries, contact_submissions (+pipeline), newsletter_subs
(+tokens/source), career_applications (+pipeline), content_posts (+CMS
fields), corporate_content_staff, career_jobs, content_revisions,
newsletter_campaigns, newsletter_campaign_sends, email_suppressions.

**Flag:** `MODULES__CORPORATE_ENABLED` (on by default; required by identity).
Config: `EMAIL_WEBHOOK_SECRET`, `CORPORATE_CONTACT_INBOX_EMAIL`,
`ENGINE_UI_BASE_URL` (the public link base for emailed URLs).

**Remaining (P6, other steps):** website re-point, Mongo→Postgres data
migration, neryva_backend retirement.

**Public interface:** `EmailService.sendTemplate(...)`,
`SuppressionService`, `NewsletterService`, `ContentService`,
`CareersService`, `ContactInboxService`.
