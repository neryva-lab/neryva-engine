-- 0055 — REL-9 F2 (release_ledger.md): seed the `agents` product rows in the
-- platform price catalog.
--
-- These are UNPRICED markers (all price columns NULL): the quota wall reads
-- the `agents` entitlement row and the invoice derivation reads the usage
-- ledger, but without catalog rows the product does not exist in the
-- commercial surface at all — every org would be unlimited-by-design AND
-- unpriceable. Markers make the product's existence explicit while
-- `deriveCost` keeps returning null for these slots (derive mode falls back
-- to reported cost + audit; enforce mode rejects), so no money moves until
-- staff sets real prices via internal/billing/price-catalog.
--
-- Idempotent by construction (WHERE NOT EXISTS): reruns and multi-release
-- applies add nothing. Staff price rows supersede these by effective dating
-- (new row, never an UPDATE) — the markers stay as history.
INSERT INTO "billing"."price_catalog"
  ("product", "kind", "model", "price_per_million_input_usd", "price_per_million_output_usd",
   "price_per_event_usd", "currency", "effective_from", "note", "created_by")
SELECT 'agents', 'model_tokens', NULL, NULL, NULL, NULL, 'USD', now(),
       'UNPRICED marker (REL-9 F2) — set model prices via the staff catalog before billing runs',
       'migration:0055'
WHERE NOT EXISTS (SELECT 1 FROM "billing"."price_catalog" WHERE "product" = 'agents' AND "kind" = 'model_tokens');
--> statement-breakpoint
INSERT INTO "billing"."price_catalog"
  ("product", "kind", "model", "price_per_million_input_usd", "price_per_million_output_usd",
   "price_per_event_usd", "currency", "effective_from", "note", "created_by")
SELECT 'agents', 'runs', NULL, NULL, NULL, NULL, 'USD', now(),
       'UNPRICED marker (REL-9 F2) — set the event price via the staff catalog before billing runs',
       'migration:0055'
WHERE NOT EXISTS (SELECT 1 FROM "billing"."price_catalog" WHERE "product" = 'agents' AND "kind" = 'runs');
