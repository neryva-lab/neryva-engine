/**
 * Assistant knowledge queries (P3) — the read port for the assistants
 * module's non-transactional knowledge-domain reads.
 *
 * Why a separate port: the 9/7/3 repository contracts cover the
 * assistant/version/snapshot aggregates and their transaction-scoped
 * cross-domain checks (delete's conversation handling, discard's
 * eval/run probes). The operate-view reads below are NOT in those
 * contracts — they are read-only, never transactional, and belong to the
 * knowledge domain's tables (`documents`, `chunks`/`embeddings`,
 * `eval_runs`, `eval_datasets`). `AssistantsService` must not query those
 * tables directly (zero `this.db.*`), and the 9/7/3 interfaces are frozen —
 * so these reads get their own narrow port.
 *
 * The port carries persistence only: domain rules (vacuous coverage,
 * vanished documents, degraded computation) stay in the service. The
 * PostgreSQL implementation preserves the pre-extraction SQL verbatim.
 */
export interface ChunkEmbeddingStats {
  total: number;
  embedded: number;
}

export interface LatestEvalDecision {
  decision: string;
  score: string | null;
  finished_at: string | null;
}

export interface IAssistantKnowledgeQueries {
  /**
   * Document states keyed by document id. Ids with no row are absent
   * from the map (the caller treats a missing state as 'deleted').
   */
  getDocumentStates(orgId: string, documentIds: string[]): Promise<Map<string, string>>;

  /**
   * Chunk/embedding aggregates per (document version, model) pair, keyed
   * by version id. Pairs with no chunk rows are absent from the map (the
   * caller applies the vacuous-coverage rule).
   */
  getChunkEmbeddingStats(
    orgId: string,
    pairs: Array<{ versionId: string; model: string }>,
  ): Promise<Map<string, ChunkEmbeddingStats>>;

  /**
   * Latest completed, non-shadow evaluation decision for a version
   * (formal verdict only — shadow observations never surface here).
   * Null when no completed evaluation exists.
   */
  getLatestEvalDecision(orgId: string, versionId: string): Promise<LatestEvalDecision | null>;

  /** Eval dataset id by exact name. Null when no dataset carries the name. */
  findEvalDatasetId(orgId: string, name: string): Promise<string | null>;
}
