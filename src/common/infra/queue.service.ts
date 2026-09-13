import { Queue } from 'bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { env } from '../config/env';

/**
 * BullMQ queue factory with the partitioning namespace rule: every module
 * gets its own namespaced queue, so one module's backlog can never starve
 * another's (partitioning Tier-1, correction C9 — engine-side only).
 *
 * The separator is `.`, not `:` — BullMQ forbids `:` in queue names (it is
 * the internal key delimiter; `new Queue('a:b')` throws at construction).
 * ALWAYS build worker-side names with bullQueueName() — never retype the
 * literal — so producers and consumers cannot drift apart.
 *
 * Workers are created by the modules that own them (graceful-shutdown is the
 * owning module's responsibility); this factory only shares queue handles.
 */
export function bullQueueName(namespace: string): string {
  return `${namespace}.default`;
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();

  queue(namespace: string): Queue {
    const name = bullQueueName(namespace);
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
