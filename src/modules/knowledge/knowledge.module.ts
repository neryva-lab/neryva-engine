import { Module } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service';
import { MemoryService } from './memory.service';
import { RetrievalService } from './retrieval.service';
import { EmbeddingService } from './embedding.service';
import { KnowledgeIngestionWorker, DefaultScanner } from './ingestion.service';
import { KnowledgeController } from './knowledge.controller';

/**
 * Knowledge plane module — Phase 7. The ingestion worker is provided here
 * and registered by the WorkersModule composition (it self-gates on the
 * worker host flag). The scanner port binds to DefaultScanner until a real
 * malware scanner service is configured.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [ArtifactsService, MemoryService, RetrievalService, EmbeddingService, DefaultScanner, KnowledgeIngestionWorker],
  exports: [ArtifactsService, MemoryService, RetrievalService, KnowledgeIngestionWorker],
})
export class KnowledgeModule {}
