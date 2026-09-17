-- 0064 — Embedding model scope (ai-native-review.md P0: BUG-1 + GAP-1).
--
-- The vector legs compared query vectors against ALL embedding rows regardless
-- of `embeddings.model`, so during any embedding-model migration window scores
-- mixed across vector spaces. Retrieval must scope each leg to the query's
-- model (see retrieval.service.ts query-model resolution).
--
-- `memory_items` had no model provenance at all: semantic-memory rows could
-- never be scoped. New rows stamp the producing model; legacy NULL rows keep
-- participating (NULL-inclusive predicate) and converge out as memories are
-- re-approved/rewritten (memories are TTL'd and superseded, unlike document
-- vectors which the re-embed worker migrates).
--
-- `embeddings` needs NO change here: uq_embeddings_chunk (chunk_id, model)
-- already exists (0026), so per-model sets are well-defined and the worker's
-- ON CONFLICT DO NOTHING is meaningful.
ALTER TABLE "memory_items" ADD COLUMN "embedding_model" varchar(64);
CREATE INDEX "ix_memory_items_org_model" ON "memory_items" USING btree ("organization_id", "embedding_model");
