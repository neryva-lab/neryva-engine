-- 0036 — RunBudgets authority: per-assistant budget_policy (final_ledger.md FL-1.2)
--
-- Studio's run loop enforces the contract's RunBudgets (max_total_tokens,
-- max_cost_micros, wall_clock_seconds + tool/model-call caps), but the Engine
-- manifest served hardcoded defaults: budgets were not configurable per
-- assistant. This column carries the pinned budget set on the version and the
-- immutable policy snapshot (the run-time pin, same pattern as 0031).
-- Expand-only: new nullable column; absent/empty policy keeps the defaults.

ALTER TABLE "assistant_versions" ADD COLUMN "budget_policy" jsonb;
ALTER TABLE "policy_snapshots" ADD COLUMN "budget_policy" jsonb;
