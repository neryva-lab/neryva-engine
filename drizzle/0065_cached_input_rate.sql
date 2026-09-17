-- 0065 — Cached-input price rate (ai-native-review.md P2: cache economics).
--
-- Providers price prompt-cache HITS differently from misses (often an order
-- of magnitude cheaper). The commit-time derivation priced every prompt token
-- at the full input rate, so cached-heavy runs invoiced wildly high. Price
-- points gain an optional cached-input rate; NULL = legacy point (cached
-- tokens price at the input rate, exactly as before — no restatement).
ALTER TABLE "model_cost_entries" ADD COLUMN "cost_micros_per_1k_cached_input" bigint;
