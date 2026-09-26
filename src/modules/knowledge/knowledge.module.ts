import { Module } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service';
import { MemoryService } from './memory.service';
import { RetrievalService } from './retrieval.service';
import { EmbeddingService } from './embedding.service';
import { RerankerService } from './reranker.port';
import { QueryRewriteService } from './query-rewrite.port';
import { KnowledgeIngestionWorker, DefaultScanner } from './ingestion.service';
import { KnowledgeController } from './knowledge.controller';
import { ConnectorsController } from './connectors.controller';
import { HarnessParityController } from './harness-parity.controller';
import { EvalService } from './eval.service';
import { AnalyticsQueryService } from './analytics.query.service';
import { ConnectorsService } from './connectors.service';
import { ConnectorSyncWorker } from './connectors.worker';
import { ReEmbedWorker } from '../../workers/reembed.worker';
import { SearchIndexSyncWorker } from '../../workers/search-index-sync.worker';
import { ConfigPublishModule } from '../config-publish/config-publish.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AssistantRepositoriesModule } from '../assistants/repositories/assistant-repositories.module';
import { env } from '../../common/config/env';
import { DbService } from '../../common/infra/db/db.service';
import { MongoDbService } from '../../common/infra/db/mongo/mongo.service';
import {
  SEARCH_BACKEND,
  isAtlasTopology,
  resolveSearchBackendKind,
} from './search/search-backend';
import type { ISearchBackend } from './search/search-backend';
import { PgVectorSearchBackend } from './search/pgvector-search.backend';
import { AtlasVectorSearchBackend } from './search/atlas-search.backend';
import { QdrantSearchBackend, probeQdrant } from './search/qdrant-search.backend';
import {
  UPLOAD_SESSION_REPOSITORY,
  INGESTION_REPOSITORY,
  DOCUMENT_ACL_REPOSITORY,
  RETRIEVAL_ACL_REPOSITORY,
  RETRIEVAL_REPOSITORY,
  MEMORY_ITEM_REPOSITORY,
  MEMORY_DECISION_REPOSITORY,
  REEMBED_REPOSITORY,
  CONNECTOR_ACCOUNT_REPOSITORY,
  CONNECTOR_OAUTH_APP_REPOSITORY,
  CONNECTOR_DOCUMENT_TOMBSTONE_REPOSITORY,
  CONNECTOR_INGEST_STAGING_REPOSITORY,
  ARTIFACT_REPOSITORY,
  DOCUMENT_REPOSITORY,
  ANALYTICS_ROLLUP_REPOSITORY,
  EVAL_DATASET_REPOSITORY,
  EVAL_RUN_REPOSITORY,
} from './repositories/repository-tokens';
import { PgUploadSessionRepository } from './repositories/pg-upload-session.repository';
import { MongoUploadSessionRepository } from './repositories/mongo-upload-session.repository';
import { PgIngestionRepository } from './repositories/pg-ingestion.repository';
import { MongoIngestionRepository } from './repositories/mongo-ingestion.repository';
import { PgDocumentAclRepository } from './repositories/pg-document-acl.repository';
import { MongoDocumentAclRepository } from './repositories/mongo-document-acl.repository';
import { PgRetrievalAclRepository } from './repositories/pg-retrieval-acl.repository';
import { MongoRetrievalAclRepository } from './repositories/mongo-retrieval-acl.repository';
import { PgRetrievalRepository } from './repositories/pg-retrieval.repository';
import { MongoRetrievalRepository } from './repositories/mongo-retrieval.repository';
import { PgMemoryItemRepository } from './repositories/pg-memory-item.repository';
import { MongoMemoryItemRepository } from './repositories/mongo-memory-item.repository';
import { PgMemoryDecisionRepository } from './repositories/pg-memory-decision.repository';
import { MongoMemoryDecisionRepository } from './repositories/mongo-memory-decision.repository';
import { PgReEmbedRepository } from './repositories/pg-reembed.repository';
import { MongoReEmbedRepository } from './repositories/mongo-reembed.repository';
import { PgConnectorAccountRepository } from './repositories/pg-connector-account.repository';
import { MongoConnectorAccountRepository } from './repositories/mongo-connector-account.repository';
import { PgConnectorOAuthAppRepository } from './repositories/pg-connector-oauth-app.repository';
import { MongoConnectorOAuthAppRepository } from './repositories/mongo-connector-oauth-app.repository';
import { PgConnectorDocumentTombstoneRepository } from './repositories/pg-connector-document-tombstone.repository';
import { MongoConnectorDocumentTombstoneRepository } from './repositories/mongo-connector-document-tombstone.repository';
import { PgConnectorIngestStagingRepository } from './repositories/pg-connector-ingest-staging.repository';
import { MongoConnectorIngestStagingRepository } from './repositories/mongo-connector-ingest-staging.repository';
import { PgArtifactRepository } from './repositories/pg-artifact.repository';
import { MongoArtifactRepository } from './repositories/mongo-artifact.repository';
import { PgDocumentRepository } from './repositories/pg-document.repository';
import { MongoDocumentRepository } from './repositories/mongo-document.repository';
import { PgAnalyticsRollupRepository } from './repositories/pg-analytics-rollup.repository';
import { MongoAnalyticsRollupRepository } from './repositories/mongo-analytics-rollup.repository';
import { PgEvalDatasetRepository } from './repositories/pg-eval-dataset.repository';
import { MongoEvalDatasetRepository } from './repositories/mongo-eval-dataset.repository';
import { PgEvalRunRepository } from './repositories/pg-eval-run.repository';
import { MongoEvalRunRepository } from './repositories/mongo-eval-run.repository';

/**
 * Provider selection for the knowledge persistence ports (P3).
 *
 * This factory is the SINGLE place where the active provider is chosen:
 * `DB_PROVIDER=mongodb` selects the MongoDB implementation, anything else
 * (default `postgres`) selects PostgreSQL. Services inject only the
 * interface tokens and stay provider-blind; repositories contain no
 * provider conditionals.
 */
function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService, backend: ISearchBackend) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService, SEARCH_BACKEND],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

/**
 * P4 search-backend resolution. Async factory — Nest awaits it before any
 * consumer instantiates, so a fail-closed resolution error aborts boot
 * loudly instead of serving requests with a degraded backend.
 *
 * Priority (resolveSearchBackendKind): postgres → pgvector; mongodb +
 * Atlas topology → Atlas Vector Search; mongodb + reachable QDRANT_URL →
 * Qdrant; anything else → throw (never a silent lexical-only fallback).
 */
const searchBackendProvider = {
  provide: SEARCH_BACKEND,
  useFactory: async (db: DbService, mongo: MongoDbService): Promise<ISearchBackend> => {
    if (!isMongo()) {
      return new PgVectorSearchBackend(db);
    }
    const mongoUri = env.MONGODB_URI ?? '';
    if (isAtlasTopology(mongoUri)) {
      const backend: ISearchBackend = new AtlasVectorSearchBackend(mongo);
      await backend.onBoot?.();
      return backend;
    }
    const qdrantUrl = env.QDRANT_URL;
    const probe = qdrantUrl
      ? await probeQdrant(qdrantUrl)
      : { ok: false as const, error: 'QDRANT_URL is not set' };
    const kind = resolveSearchBackendKind({
      dbProvider: 'mongodb',
      mongoUri,
      qdrantUrl,
      qdrantReachable: probe.ok,
      qdrantProbeError: probe.error,
    });
    // resolveSearchBackendKind throws for every non-qdrant branch here.
    if (kind !== 'qdrant' || !qdrantUrl) {
      throw new Error(`search backend resolution returned unexpected kind '${kind}'`);
    }
    const backend = new QdrantSearchBackend(qdrantUrl);
    await backend.onBoot();
    return backend;
  },
  inject: [DbService, MongoDbService],
};

/**
 * Knowledge plane module — Phase 7. The ingestion worker is provided here
 * and registered by the WorkersModule composition (it self-gates on the
 * worker host flag). The scanner port binds to DefaultScanner until a real
 * malware scanner service is configured.
 *
 * `AssistantRepositoriesModule` is imported (not `AssistantsModule` — that
 * would be a module cycle, since `AssistantsModule` imports this module)
 * so `EvalService` can inject the assistants persistence ports.
 */
@Module({
  imports: [ConfigPublishModule, OrganizationsModule, AssistantRepositoriesModule],
  controllers: [KnowledgeController, ConnectorsController, HarnessParityController],
  providers: [
    ArtifactsService,
    MemoryService,
    RetrievalService,
    EmbeddingService,
    RerankerService,
    QueryRewriteService,
    DefaultScanner,
    KnowledgeIngestionWorker,
    ConnectorsService,
    ConnectorSyncWorker,
    EvalService,
    searchBackendProvider,
    AnalyticsQueryService,
    ReEmbedWorker,
    SearchIndexSyncWorker,
    repositoryProvider(
      UPLOAD_SESSION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoUploadSessionRepository(mongo) : new PgUploadSessionRepository(db)),
    ),
    repositoryProvider(
      INGESTION_REPOSITORY,
      (db, mongo, backend) => (isMongo() ? new MongoIngestionRepository(mongo, backend) : new PgIngestionRepository(db)),
    ),
    repositoryProvider(
      DOCUMENT_ACL_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoDocumentAclRepository(mongo) : new PgDocumentAclRepository(db)),
    ),
    repositoryProvider(
      RETRIEVAL_ACL_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoRetrievalAclRepository(mongo) : new PgRetrievalAclRepository(db)),
    ),
    repositoryProvider(
      RETRIEVAL_REPOSITORY,
      (db, mongo, backend) => (isMongo() ? new MongoRetrievalRepository(mongo, backend) : new PgRetrievalRepository(db)),
    ),
    repositoryProvider(
      MEMORY_ITEM_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoMemoryItemRepository(mongo) : new PgMemoryItemRepository(db)),
    ),
    repositoryProvider(
      MEMORY_DECISION_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoMemoryDecisionRepository(mongo) : new PgMemoryDecisionRepository(db)),
    ),
    repositoryProvider(
      REEMBED_REPOSITORY,
      (db, mongo, backend) => (isMongo() ? new MongoReEmbedRepository(mongo, backend) : new PgReEmbedRepository(db)),
    ),
    repositoryProvider(
      CONNECTOR_ACCOUNT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoConnectorAccountRepository(mongo) : new PgConnectorAccountRepository(db)),
    ),
    repositoryProvider(
      CONNECTOR_OAUTH_APP_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoConnectorOAuthAppRepository(mongo) : new PgConnectorOAuthAppRepository(db)),
    ),
    repositoryProvider(
      CONNECTOR_DOCUMENT_TOMBSTONE_REPOSITORY,
      (db, mongo) =>
        isMongo()
          ? new MongoConnectorDocumentTombstoneRepository(mongo)
          : new PgConnectorDocumentTombstoneRepository(db),
    ),
    repositoryProvider(
      CONNECTOR_INGEST_STAGING_REPOSITORY,
      (db, mongo) =>
        isMongo()
          ? new MongoConnectorIngestStagingRepository(mongo)
          : new PgConnectorIngestStagingRepository(db),
    ),
    repositoryProvider(
      ARTIFACT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoArtifactRepository(mongo) : new PgArtifactRepository(db)),
    ),
    repositoryProvider(
      DOCUMENT_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoDocumentRepository(mongo) : new PgDocumentRepository(db)),
    ),
    repositoryProvider(
      ANALYTICS_ROLLUP_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoAnalyticsRollupRepository(mongo) : new PgAnalyticsRollupRepository(db)),
    ),
    repositoryProvider(
      EVAL_DATASET_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoEvalDatasetRepository(mongo) : new PgEvalDatasetRepository(db)),
    ),
    repositoryProvider(
      EVAL_RUN_REPOSITORY,
      (db, mongo) => (isMongo() ? new MongoEvalRunRepository(mongo) : new PgEvalRunRepository(db)),
    ),
  ],
  exports: [ArtifactsService, MemoryService, RetrievalService, KnowledgeIngestionWorker, EvalService],
})
export class KnowledgeModule {}
