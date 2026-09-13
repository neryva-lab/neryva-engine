import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import type { OutboxConsumer } from '../common/infra/outbox/consumer';
import type { OutboxEvent } from '../common/infra/outbox/schema';
import { env } from '../common/config/env';
import { uuidv7 } from '../common/ids/uuidv7';

/**
 * FL-3.10 — auto memory-extraction proposer (flag-gated via
 * HARNESS__AUTO_MEMORY_ENABLED). On run completion, high-signal sentences in
 * the final assistant message ("remember that ...", "the user prefers ...")
 * are proposed through the memory-proposal pipeline — PROPOSALS ARE NEVER
 * DURABLE TRUTH by themselves; approval stays with the explicit decision API
 * (Phase 7.8). Heuristic-only: no model call inside the consumer (cost +
 * determinism); the extraction prompt path lands with the eval worker.
 */
@Injectable()
export class MemoryProposerConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(MemoryProposerConsumer.name);
  private static readonly SIGNAL_RE = /(?:remember that|note that|the user prefers|the user wants|important:)\s+([^.!?]{10,300})/gi;

  readonly name = 'memory-proposer';
  readonly eventTypes = ['run.completed'];

  constructor(private readonly db: DbService) {}

  async handle(event: OutboxEvent): Promise<void> {
    if (!env.HARNESS__AUTO_MEMORY_ENABLED) {
      return;
    }
    const payload = (event.payload ?? {}) as { run_id?: string; conversation_id?: string; message_id?: string };
    if (!payload.run_id || !payload.message_id) {
      return;
    }
    const proposals: Array<{ value: string }> = [];
    await this.db.withOrg(event.organizationId, async (tx) => {
      const rows = await tx.execute(sql`
        select content from messages where id = ${payload.message_id!}::uuid limit 1
      `);
      const content = (rows.rows[0] as { content?: { text?: unknown } } | undefined)?.content;
      const text = typeof content?.text === 'string' ? content.text : '';
      for (const match of text.matchAll(MemoryProposerConsumer.SIGNAL_RE)) {
        proposals.push({ value: match[1]?.trim().slice(0, 2000) ?? '' });
      }
      for (const proposal of proposals) {
        if (!proposal.value) continue;
        await tx.execute(sql`
          insert into memory_proposals (id, organization_id, run_id, proposal_ref, scope, value, provenance)
          values (${uuidv7()}::uuid, ${event.organizationId}::uuid, ${payload.run_id!}::uuid,
                  ${'auto:' + payload.run_id + ':' + proposals.indexOf(proposal)}, 'conversation', ${proposal.value}, 'auto_extraction')
          on conflict (organization_id, proposal_ref) do nothing
        `);
      }
      void eq;
    });
    if (proposals.length > 0) {
      MemoryProposerConsumer.logger.log(`auto-proposed ${proposals.length} memory item(s) from run ${payload.run_id}`);
    }
  }
}
