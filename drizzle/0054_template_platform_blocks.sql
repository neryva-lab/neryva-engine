-- 0054 — REL-6.1 (release_ledger.md): platform-level template kill.
--
-- GAP-10 (release_gap_report.md §5): a poisoned/misbehaving template could
-- not be stopped platform-wide — org-scoped control blocks never see new
-- installs. A platform block is staff-written, GLOBAL (price_catalog
-- posture: no RLS, staff-only surface), and checked at every effect point:
-- template install and new release-pointer assignment for assistants
-- installed from the slug. Lifting records who and why; history is kept.

CREATE TABLE "template_platform_blocks" (
  "id" uuid PRIMARY KEY,
  "slug" varchar(128) NOT NULL,
  "reason" varchar(512) NOT NULL,
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "lifted_at" timestamptz,
  "lifted_by" varchar(128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_template_platform_blocks_active" ON "template_platform_blocks" ("slug") WHERE "lifted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "ix_template_platform_blocks_slug" ON "template_platform_blocks" ("slug", "created_at");
