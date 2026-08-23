# Corporate — Implementation Plan

**Workstream:** the engine's `corporate` module — email service first, then the public forms/content endpoints that retire `neryva_backend`.
**Binding docs:** [ADR-004](../../../architecture/decisions/ADR-004-frontend-portal-corporate.md) (D3/D4 + Am.1), [`frontend-and-portal-plan.md`](../../frontend-and-portal-plan.md) §5/§8, [partitioning.md](../../../architecture/partitioning.md) (Tier-2 isolation).

## Current state (verified)

- `corporate/neryva_backend` (Express/MongoDB): contact, newsletter, careers, blog CMS, website accounts (bcrypt/JWT/OTP), nodemailer email — parked, still the reference implementation for porting. **It has 2 uncommitted local changes** (verified) — commit/push them before anything touches that folder.
- Engine has **no email service** (doc 06 open question Q1) and no public (unauthenticated) endpoints — everything today authenticates via L2/L4.

## Target

`backend/app/corporate/` — an isolated module: transactional email service, public rate-limited form endpoints, staff content admin. No credential store (ADR-004 D4: website login becomes the Neryva Account; newsletter/careers/contact submitters are plain rows, never accounts).

## Steps (E1 first — it unblocks identity)

**E1 — Email service (no schema).** `backend/app/corporate/email.py`: SMTP provider abstraction (settings `SMTP_*`; dev transport = log/file), template registry (code + password login, invite, newsletter double opt-in), delivery audit rows. Rate-limited send. *Gate:* unit tests with a fake transport; **this resolves 06 Q1 and is identity I-1a's dependency.**

**E2 — Public endpoints + tables (migration 0020).** `contact_submissions`, `newsletter_subs` (double opt-in token hash), `career_applications` (file ref only — object storage path, no blobs in Postgres). Routes `POST /public/{contact,newsletter,careers}`: no auth, per-IP `RateLimiter`, honeypot + basic validation, audit `corporate.submission`. *Gate:* rate-limit + honeypot tests; RLS not tenant-scoped (platform-plane tables, like accounts).

**E3 — Content admin.** `content_posts` table + `/platform/content/**` CRUD for the staff role (website blog authoring; renders stay static from the website's `neryva_data` packs, posts sync via a build-time export endpoint). *Gate:* staff-role route tests; contract re-pin (owner `platform`).

**E4 — Website re-point (frontend task, tracked here).** neryva-website drops its `src/api` calls to neryva_backend in favor of `/public/*`; its local auth pages are removed (login = Neryva Account). *Gate:* website e2e against the engine.

**E5 — Data migration.** One script: Mongo → Postgres for newsletter subs + contact history worth keeping (careers/blog per judgment). *Gate:* row-count reconciliation report.

**E6 — Retire neryva_backend** (ADR-004 §8): DEPRECATED marker → two-week unused verification (its logs show zero traffic) → `git rm -r corporate/neryva_backend` (history on its GitHub remote) → shut Vercel + Mongo Atlas → update `Neryva/docs/REPO_MAP.md`.

## Isolation rules (partitioning Tier-2)

`app/corporate/` imports platform services only; **nothing imports it**; no product data, no tenant scope, no L1 requirements on `/public/*`. Cross-module needs (e.g., identity using E1's email service) go through its public functions — email is a platform facility hosted in the module.

## Files touched

`backend/app/corporate/{__init__,email.py,routes_public.py,routes_content.py}`, `backend/alembic/versions/0020_corporate.py`, `backend/app/settings/env.py` (SMTP), `backend/tests/test_corporate_*.py`, contract re-pin.
