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
import { ConfigPublishModule } from '../config-publish/config-publish.module';

/**
 * Knowledge plane module — Phase 7. The ingestion worker is provided here
 * and registered by the WorkersModule composition (it self-gates on the
 * worker host flag). The scanner port binds to DefaultScanner until a real
 * malware scanner service is configured.
 */
@Module({
  imports: [ConfigPublishModule],
  controllers: [KnowledgeController, ConnectorsController, HarnessParityController],
  providers: [ArtifactsService, MemoryService, RetrievalService, EmbeddingService, RerankerService, QueryRewriteService, DefaultScanner, KnowledgeIngestionWorker, ConnectorsService, ConnectorSyncWorker, EvalService, AnalyticsQueryService],
  exports: [ArtifactsService, MemoryService, RetrievalService, KnowledgeIngestionWorker],
})
export class KnowledgeModule {}
