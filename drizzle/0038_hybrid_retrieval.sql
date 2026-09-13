-- 0038 — Retrieval workstream: hybrid search, re-embed versioning, memory vectors
-- (final_ledger.md FL-2.1 / FL-2.2 / FL-2.4)

-- FL-2.1 — lexical leg of hybrid retrieval: a STORED tsvector generated column
-- over the chunk text + a GIN index. Same-derived-data rule as chunks themselves
-- (rebuildable, never business truth). The engine's `english` config is pinned
-- so query planning is stable across locales.
ALTER TABLE "chunks" ADD COLUMN "fts" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("text", ''))) STORED;
CREATE INDEX "ix_chunks_fts" ON "chunks" USING "gin" ("fts");

-- FL-2.2/2.3 — the embedding model a document's ACTIVE vectors were computed
-- with. NULL = pre-0038 rows (embedded with the legacy default); the re-embed
-- worker treats NULL as "needs re-embed" only when the org configures a
-- different model — backwards compatible by default.
ALTER TABLE "documents" ADD COLUMN "embedding_model" varchar(64);

-- FL-2.4 — semantic memory: approval-time embedding on memory_items.
-- ACL/tenant predicates run in the same statement as the cosine ordering
-- (never post-filtered); HNSW keeps manifest-time queries cheap.
ALTER TABLE "memory_items" ADD COLUMN "embedding" vector(1536);
CREATE INDEX "ix_memory_items_embedding" ON "memory_items" USING "hnsw" ("embedding" vector_cosine_ops);
