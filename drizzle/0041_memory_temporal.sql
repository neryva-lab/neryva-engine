-- 0041 — Temporal memory metadata (final_ledger.md FL-3.9, Zep/Graphiti pattern
-- with Neryva's policy layer): validity windows + supersession on memory_items.
-- Rows gain a validity interval (valid_from defaulting to creation) and an
-- explicit invalid_at tombstone; supersedes records which prior item a new
-- memory replaces (the old item is marked invalid_at in the same TX by the
-- service layer). Queries keep the existing deleted_at/expiry predicates and
-- add invalid_at IS NULL OR invalid_at > now().

ALTER TABLE "memory_items" ADD COLUMN "valid_from" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "memory_items" ADD COLUMN "invalid_at" timestamptz;
ALTER TABLE "memory_items" ADD COLUMN "supersedes" uuid REFERENCES "memory_items"("id") ON DELETE SET NULL;
CREATE INDEX "ix_memory_items_validity" ON "memory_items" ("organization_id", "valid_from", "invalid_at");
