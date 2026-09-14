-- 0051 — REL-1.6 (release_ledger.md): the platform model catalog.
--
-- GAP-09 (release_gap_report.md §5): the model catalog was org-authored JSON
-- via config-publish with nothing behind it, and compatibility could not
-- distinguish "unknown model" from "known model with no key for this org".
-- This table is the platform's seeded source of truth for model IDENTITY
-- (price_catalog posture: GLOBAL, no RLS, staff-managed, audited). Pricing
-- is a separate effective-dated ledger (REL-4.2) and intentionally lives
-- elsewhere. The org-published model_catalog config remains the org's own
-- governance allowlist on top of this.

CREATE TABLE "model_catalog_entries" (
  "id" uuid PRIMARY KEY,
  "provider" varchar(32) NOT NULL,
  "model_id" varchar(128) NOT NULL,
  "display_name" varchar(256) NOT NULL,
  "context_window_tokens" integer,
  "max_output_tokens" integer,
  "capabilities" jsonb NOT NULL DEFAULT '{}',
  "residency" varchar(32),
  "status" varchar(16) NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_model_catalog_status" CHECK ("status" IN ('active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_catalog_provider_model" ON "model_catalog_entries" ("provider", "model_id");
--> statement-breakpoint
CREATE INDEX "ix_model_catalog_status" ON "model_catalog_entries" ("status", "provider");
