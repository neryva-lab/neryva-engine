import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { REEMBED_REPOSITORY } from '../modules/knowledge/repositories/repository-tokens';
import type { IReEmbedRepository } from '../modules/knowledge/repositories/reembed.repository';
import { env } from '../common/config/env';
import { EmbeddingService } from '../modules/knowledge/embedding.service';
import { ConfigPublishService } from '../modules/config-publish/config-publish.service';

/**
 * Re-embed worker (FL-2.2) — resumable, batched re-indexing when an org's
 * configured embedding model changes (FL-2.3 `knowledge_config`).
 *
 * Resumability: `documents.embedding_model` IS the cursor. A document whose
 * active vectors were computed with a model different from the org's
 * configured model is re-embedded; the swap is ATOMIC PER DOCUMENT — new
 * embeddings insert and the document's model pointer flips in one
 * transaction, so a crash mid-batch leaves every document either fully on
 * the old model or fully on the new one. Zero-downtime reads: old-model
 * rows are kept until the new-model rows for the same document are in, then
 * swept in the same TX as the pointer flip.
 */
@Injectable()
export class ReEmbedWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(ReEmbedWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(REEMBED_REPOSITORY) private readonly reembed: IReEmbedRepository,
    private readonly embedding: EmbeddingService,
    private readonly configPublish: ConfigPublishService,
  ) {}

  onModuleInit(): void {
    if (!env.WORKERS__REEMBED_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    ReEmbedWorker.logger.log('re-embed worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const orgs = await this.reembed.listReadyOrgIds(500);
      for (const orgId of orgs) {
        await this.reembedOrg(orgId);
      }
    } catch (err) {
      ReEmbedWorker.logger.warn(`re-embed tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reembedOrg(orgId: string): Promise<void> {
    const config = await this.configPublish.latest(orgId, 'knowledge_config', null);
    if (!config) {
      // Org has not opted into a specific model: NULL stays legacy and the
      // legacy vectors remain authoritative — no forced re-index.
      return;
    }
    const configured = String((config.payload as { embedding_model?: string }).embedding_model ?? '');
    const effective = configured || this.embedding.model;

    const pending = await this.reembed.listPendingDocuments(orgId, effective, env.WORKERS__REEMBED_BATCH);

    for (const doc of pending) {
      // P0: per-document isolation — a parity failure (or any transient) on
      // one document must not starve its siblings until the next tick. The
      // document stays pending (pointer unflipped) and converges on retry.
      try {
        await this.reembedDocument(orgId, doc.id, effective);
      } catch (err) {
        ReEmbedWorker.logger.warn(`re-embed of document ${doc.id} deferred: ${(err as Error).message}`);
      }
    }
  }

  /** Atomic per-document swap: new vectors in, old sweep + pointer flip in one TX. */
  private async reembedDocument(orgId: string, documentId: string, targetModel: string): Promise<void> {
    const chunks = await this.reembed.listDocumentChunks(orgId, documentId);
    const vectors =
      chunks.length === 0 ? [] : await this.embedding.embed(chunks.map((c) => c.text));
    const pairs: Array<{ chunkId: string; vector: number[] }> = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vec = vectors[i];
      if (!chunk || !vec) {
        continue;
      }
      pairs.push({ chunkId: chunk.chunkId, vector: vec });
    }
    // The repository owns the atomic swap: target-model inserts, chunk-count
    // parity BEFORE the pointer flip (mismatch throws retryable — the
    // document stays pending and converges next tick), pointer flip, and
    // stale-model sweep, all in one TX. Zero-chunk documents flip directly.
    const result = await this.reembed.swapDocumentEmbeddings({
      orgId,
      documentId,
      targetModel,
      vectors: pairs,
      at: new Date(),
    });
    if (result.chunks > 0) {
      ReEmbedWorker.logger.log(
        `document ${documentId} re-embedded on ${targetModel} (${result.chunks} chunks, ${result.staleModelsSwept} stale model(s) swept)`,
      );
    }
  }
}
