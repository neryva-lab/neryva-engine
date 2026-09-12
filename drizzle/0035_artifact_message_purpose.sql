-- 0035 — message attachment purpose (ai_harness_plan.md H0.7)
--
-- Artifacts previously allowed knowledge/checkpoint/export/... purposes only,
-- so a chat attachment had no home. Extend the purpose allowlist with
-- MESSAGE_ATTACHMENT (user → run files) and GENERATED_MEDIA (run → user
-- files, e.g. images produced by a media tool). Expand-only; existing rows
-- keep their purpose. Media-type widening lives in code (artifacts service).

ALTER TABLE "artifacts" DROP CONSTRAINT "chk_artifacts_purpose";
ALTER TABLE "artifacts" ADD CONSTRAINT "chk_artifacts_purpose" CHECK (purpose IN ('SOURCE_DOCUMENT','EXPORT','CHECKPOINT','TOOL_RESULT','TRANSCRIPT','COVER','MESSAGE_ATTACHMENT','GENERATED_MEDIA'));
