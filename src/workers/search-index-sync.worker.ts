import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MongoDbService } from '../common/infra/db/mongo/mongo.service';
import { env } from '../common/config/env';
import { SEARCH_BACKEND } from '../modules/knowledge/search/search-backend';
import type { ISearchBackend } from '../modules/knowledge/search/search-backend';
import { drainSearchIndexOutbox } from '../modules/knowledge/search/search-index-outbox';

/**
 * Search-index sync sweeper (P4) — replays stranded `search_index_outbox`
 * intents for sidecar vector backends (Qdrant).
 *
 * The repositories drain their own intents inline right after commit (fast
 * path), so this worker only ever sees intents stranded by a crash between
 * the transaction commit and the inline drain, or by a Qdrant outage. Drain
 * is idempotent and failure-safe: intents are claimed atomically and
 * re-queued with backoff on failure, never dropped.
 *
 * Idle unless `WORKERS__SEARCH_INDEX_SYNC_ENABLED` and the resolved
 * backend actually requires sidecar sync (pgvector/Atlas index the
 * canonical store directly — nothing to sweep).
 */
@Injectable()
export class SearchIndexSyncWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(SearchIndexSyncWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly mongo: MongoDbService,
    @Inject(SEARCH_BACKEND) private readonly backend: ISearchBackend,
  ) {}

  onModuleInit(): void {
    if (!env.WORKERS__SEARCH_INDEX_SYNC_ENABLED) {
      return;
    }
    if (!this.backend.requiresSidecarSync) {
      SearchIndexSyncWorker.logger.log(
        `sidecar sync not required by the ${this.backend.backendKind} backend — worker idle`,
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), env.WORKERS__SEARCH_INDEX_SYNC_INTERVAL_MS);
    this.timer.unref();
    SearchIndexSyncWorker.logger.log('search index sync worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { claimed, applied, failed } = await drainSearchIndexOutbox(this.mongo, this.backend, {
        limit: 500,
      });
      if (claimed > 0) {
        SearchIndexSyncWorker.logger.log(
          `search index sync tick: claimed=${claimed} applied=${applied} failed=${failed}`,
        );
      }
    } catch (err) {
      SearchIndexSyncWorker.logger.warn(`search index sync tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
