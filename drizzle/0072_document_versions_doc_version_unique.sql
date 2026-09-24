-- A4-11: version numbers are a per-document sequence — enforce uniqueness at
-- the database level as defense-in-depth behind the FOR UPDATE serialization
-- in the ingestion worker. Prevents silent duplicate versions if the
-- application-level lock is ever lost in a refactor or a new writer appears.
CREATE UNIQUE INDEX "uq_document_versions_doc_version" ON "document_versions" USING btree ("document_id","version");
