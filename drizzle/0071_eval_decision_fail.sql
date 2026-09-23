-- 0071 — A2-80: eval verdicts gain FAIL (cases failed).
--
-- The engine's completeRun previously decided PASS for any run without
-- block reasons or warnings — including runs whose every case failed. The
-- console renders the engine's decision verbatim, so a failing run (score
-- 0.0000, "Failing cases · 1") shipped with a green PASS pill. The verdict
-- truth lives in completeRun: BLOCK > FAIL > WARN > PASS, where FAIL means
-- one or more cases failed. The publish gate (release-gate.ts) and the
-- rollout promotion gate (rollouts.service.ts) both refuse FAIL; a later
-- PASS on the same content hash clears it (latest wins).
--
-- Expand/contract: pure widening of a CHECK — no data rewrite, no
-- backfill. Pre-existing rows keep their decisions.

ALTER TABLE "eval_runs" DROP CONSTRAINT "chk_eval_runs_decision";
ALTER TABLE "eval_runs" ADD CONSTRAINT "chk_eval_runs_decision" CHECK (decision IN ('PASS','WARN','BLOCK','FAIL'));
