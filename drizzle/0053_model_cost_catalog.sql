-- 0053 — REL-4.2 (release_ledger.md): the model cost catalog.
--
-- GAP-06 (release_gap_report.md §5): per-model cost was priced at zero, so
-- invoices could not reflect AI cost and budget checks had no monetary leg.
-- Rows are append-only price points keyed (provider, model, effective_from);
-- lookup takes the newest point at or before "now". GLOBAL (price_catalog
-- posture, no RLS), staff-managed, audited. Micros are integers — never
-- floats (audit-chain number discipline).

CREATE TABLE "model_cost_entries" (
  "id" uuid PRIMARY KEY,
  "provider" varchar(64) NOT NULL,
  "model" varchar(128) NOT NULL,
  "cost_micros_per_1k_input" bigint NOT NULL,
  "cost_micros_per_1k_output" bigint NOT NULL,
  "currency" varchar(8) NOT NULL DEFAULT 'USD',
  "effective_from" timestamptz NOT NULL DEFAULT now(),
  "retired_at" timestamptz,
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_model_cost_nonnegative" CHECK ("cost_micros_per_1k_input" >= 0 AND "cost_micros_per_1k_output" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_cost_provider_model_effective" ON "model_cost_entries" ("provider", "model", "effective_from");
--> statement-breakpoint
CREATE INDEX "ix_model_cost_lookup" ON "model_cost_entries" ("provider", "model", "effective_from" DESC);
