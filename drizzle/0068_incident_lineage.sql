-- 0068 — Incident flags + version lineage (ai-native-review.md P6).
--
-- provider_credentials: routine revoke vs compromise are different incidents.
-- `compromised` + `revocation_reason` distinguish them without touching the
-- terminal status machine (rotate still refuses revoked rows; active-only
-- reads are unchanged) and without deleting the row (run_manifest joins and
-- history stand).
--
-- assistant_versions.parent_version_id: content lineage beyond rollback_of.
-- The version this version was directly derived from: the active version at
-- draft creation (create/import), the restored version (rollback), null for
-- first versions. Plain uuid, no FK (mirrors rollback_of — versions are
-- append-only; drafts vanish via discard and must not strand children).
ALTER TABLE "provider_credentials" ADD COLUMN "revocation_reason" varchar(512);
ALTER TABLE "provider_credentials" ADD COLUMN "compromised" boolean NOT NULL DEFAULT false;
ALTER TABLE "assistant_versions" ADD COLUMN "parent_version_id" uuid;
