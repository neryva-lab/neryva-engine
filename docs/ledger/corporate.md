# Ledger — corporate (`modules/corporate`)

**Namespace:** `/public/**` (forms, newsletter, careers, content reads) + `/console/content/**` (staff) · **Guard:** none (IP rate-limit + honeypot + idempotency) / staff role for content admin · **Spec:** [`dev/corporate/plan.md`](../dev/corporate/plan.md), [ADR-004 D3/D4](../architecture/decisions/ADR-004-frontend-portal-corporate.md).
**Current state (verified):** `corporate/neryva_backend` (Express/Mongo) is the reference implementation — **it has 2 uncommitted local changes; commit/push before touching the folder.** Engine has no email service, no public endpoints.

## Phases

### E-1 — Email service (FIRST — unblocks [`identity`](identity.md) I-1a and resolves doc-06 Q1)
- [ ] SMTP transport abstraction (dev transport = log/file); template registry (codes, invites, newsletter opt-in); delivery audit rows; rate-limited send
- **Gate:** unit tests with fake transport; identity can send login codes

### E-2 — Public endpoints + tables
- [ ] `contact_submissions`, `newsletter_subs` (double opt-in), `career_applications` (file refs only); `POST /public/{contact,newsletter,careers}` with rate-limit + honeypot + `Idempotency-Key`
- **Gate:** abuse-path tests (rate-limit, honeypot, replayed idempotency key); audit `corporate.submission`

### E-3 — Content admin
- [ ] `content_posts` + `/console/content/**` CRUD (staff/`content-admin` role); build-time export for the website's static rendering
- **Gate:** role tests; contract re-pin (owner `platform`)

### E-4 — Website re-point
- [ ] neryva-website calls `/public/*` + `/console/content/*`; its local auth pages removed (login = Neryva Account per ADR-004 D4)
- **Gate:** website e2e against the engine

### E-5 — Data migration
- [ ] Mongo→Postgres script (newsletter + contact history; careers/blog per judgment); row-count reconciliation report
- **Gate:** reconciliation signed off

### E-6 — neryva_backend retirement
- [ ] DEPRECATED marker; two-week zero-traffic verification (its logs); archive folder (history on its GitHub remote); shut Vercel + Atlas; REPO_MAP update
- **Gate:** retirement checklist complete; nothing references it
