import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { env } from '../../common/config/env';
import { ConnectorsService } from './connectors.service';

/**
 * Connector sync worker (FL-2.5) — scheduled incremental sweep over active
 * connector accounts. Each sync is independent; a failing account is marked
 * `error` with a bounded message and never blocks the others.
 */
@Injectable()
export class ConnectorSyncWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(ConnectorSyncWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly connectors: ConnectorsService) {}

  onModuleInit(): void {
    if (!env.WORKERS__CONNECTORS_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), env.WORKERS__CONNECTORS_INTERVAL_MS);
    this.timer.unref();
    ConnectorSyncWorker.logger.log('connector sync worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const accounts = await this.connectors.dueAccounts();
      for (const account of accounts) {
        try {
          const result = await this.connectors.sync(account.organizationId, account.id);
          if (result.synced > 0) {
            ConnectorSyncWorker.logger.log(`connector ${account.id} (${account.provider}) synced ${result.synced} document(s)`);
          }
        } catch (err) {
          ConnectorSyncWorker.logger.warn(`connector ${account.id} (${account.provider}) sync failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
