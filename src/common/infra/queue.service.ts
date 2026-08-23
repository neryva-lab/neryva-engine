import { Queue } from 'bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { env } from '../config/env';

/**
 * BullMQ queue factory with the partitioning namespace rule: every module
 * gets its own `{namespace}:` queue, so one module's backlog can never starve
 * another's (partitioning Tier-1, correction C9 — engine-side only).
 *
 * Workers are created by the modules that own them (graceful-shutdown is the
 * owning module's responsibility); this factory only shares queue handles.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();

  queue(namespace: string): Queue {
    const name = `${namespace}:default`;
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: { url: env.REDIS_URL } });
      this.queues.set(name, q);
    }
    return q;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
