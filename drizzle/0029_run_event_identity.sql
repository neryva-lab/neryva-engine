-- 0029 — run_events producer identity (ledger 5.6 fix, 2026-09-03)
--
-- AppendRunEvents dedup was keyed on the PRIMARY KEY alone, so a conformant
-- Studio event_id outside uuid format failed with 22P02, and the same
-- event_id reused across two DIFFERENT runs was silently swallowed instead
-- of being stored (event.proto: "Unique key is (run_id, event_id)").
--
-- Expand-only migration: add the producer identity column, backfill from the
-- existing PK (all rows were producer ids), then enforce the composite
-- uniqueness. No existing reads change; writers move to (run_id, event_id)
-- conflict targets in the same release.

ALTER TABLE "run_events" ADD COLUMN "event_id" varchar(64);

UPDATE "run_events" SET "event_id" = "id"::text WHERE "event_id" IS NULL;

ALTER TABLE "run_events" ALTER COLUMN "event_id" SET NOT NULL;

CREATE UNIQUE INDEX "uq_run_events_run_event_id" ON "run_events" ("run_id", "event_id");
