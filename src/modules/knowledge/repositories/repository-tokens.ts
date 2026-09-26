/**
 * DI tokens for the knowledge-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `KnowledgeModule` via a single `useFactory` per token — no
 * provider conditionals in services or repositories.
 *
 * Cross-module reads the EVAL service needs are owned by the assistants
 * slice and are NOT redefined here. The DI wiring for the eval service must
 * additionally import these tokens from
 * '../assistants/repositories/repository-tokens':
 * - `ASSISTANT_REPOSITORY` (`IAssistantRepository.findActiveVersion`)
 * - `ASSISTANT_VERSION_REPOSITORY` (`IAssistantVersionRepository`)
 * - `POLICY_SNAPSHOT_REPOSITORY` (`IPolicySnapshotRepository`)
 * - `TOOL_CATALOG_REPOSITORY` (`IToolCatalogRepository`)
 */
export const UPLOAD_SESSION_REPOSITORY = Symbol('IUploadSessionRepository');
export const INGESTION_REPOSITORY = Symbol('IIngestionRepository');
export const DOCUMENT_ACL_REPOSITORY = Symbol('IDocumentAclRepository');
export const RETRIEVAL_ACL_REPOSITORY = Symbol('IRetrievalAclRepository');
export const RETRIEVAL_REPOSITORY = Symbol('IRetrievalRepository');
export const MEMORY_ITEM_REPOSITORY = Symbol('IMemoryItemRepository');
export const MEMORY_DECISION_REPOSITORY = Symbol('IMemoryDecisionRepository');
export const REEMBED_REPOSITORY = Symbol('IReEmbedRepository');
export const CONNECTOR_ACCOUNT_REPOSITORY = Symbol('IConnectorAccountRepository');
export const CONNECTOR_OAUTH_APP_REPOSITORY = Symbol('IConnectorOAuthAppRepository');
export const CONNECTOR_DOCUMENT_TOMBSTONE_REPOSITORY = Symbol(
  'IConnectorDocumentTombstoneRepository',
);
export const CONNECTOR_INGEST_STAGING_REPOSITORY = Symbol('IConnectorIngestStagingRepository');
export const ARTIFACT_REPOSITORY = Symbol('IArtifactRepository');
export const DOCUMENT_REPOSITORY = Symbol('IDocumentRepository');
export const ANALYTICS_ROLLUP_REPOSITORY = Symbol('IAnalyticsRollupRepository');
export const EVAL_DATASET_REPOSITORY = Symbol('IEvalDatasetRepository');
export const EVAL_RUN_REPOSITORY = Symbol('IEvalRunRepository');
