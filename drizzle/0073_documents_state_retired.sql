-- A4-05 bugfix: the documents state check constraint predates the retire
-- feature and rejects state='retired', making DELETE /documents/:id always
-- fail. Allow the tombstone state.
ALTER TABLE "documents" DROP CONSTRAINT "chk_documents_state";
ALTER TABLE "documents" ADD CONSTRAINT "chk_documents_state" CHECK (state IN ('processing', 'ready', 'failed', 'retired'));
