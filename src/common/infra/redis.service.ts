import Redis from 'ioredis';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { env } from '../config/env';

/**
 * Single shared Redis connection factory. Redis is the hot-path cache and the
 * auth deny-list; availability policy: callers degrade to their documented
 * fallback (doc-06 §10.6 — correctness over latency) rather than crash.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
      keyPrefix: 'neryva:engine:',
    });
    this.client.on('error', (err) => {
      // Logged, never thrown: a Redis blip must not take the process down.
      console.error('[redis] connection error', err.message);
    });
  }

  get raw(): Redis {
    return this.client;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
