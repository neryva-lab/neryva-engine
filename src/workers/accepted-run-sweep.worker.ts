import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { recordOutboxEvent } from '../common/infra/outbox/outbox.service';
import { uuidv7 } from '../common/ids/uuidv7';
import { runs } from '../modules/conversations/schema';
import { env } from '../common/config/env';

/**
 * Accepted-run sweep — invariant 6 (every side effect has durable outcome or
 * reconciliation path). A run whose `run.created` event was consumed while
 * the runtime was unconfigured, or whose dispatch dead-lettered, would stay
 * ACCEPTED forever with no re-dispatch path. This sweep re-emits `run.created`
 * through the outbox for runs stuck in ACCEPTED past the grace window; the
 * run-dispatch consumer's state guard makes redelivery idempotent.
 */
@Injectable()
export class AcceptedRunSweepWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(AcceptedRunSweepWorker.name);
  private static readonly GRACE_MS = 5 * 60_000;
  private static readonly BATCH = 50;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cutoff = new Date(Date.now() - AcceptedRunSweepWorker.GRACE_MS).toISOString();
      const requeued = await this.db.withBypass(async (tx) => {
        const rows = await tx
          .select({ id: runs.id, organizationId: runs.organizationId, conversationId: runs.conversationId, inputMessageId: runs.inputMessageId, assistantVersionId: runs.assistantVersionId })
          .from(runs)
          .where(and(eq(runs.state, 'ACCEPTED'), sql`${runs.acceptedAt} < ${cutoff}::timestamptz`))
          .limit(AcceptedRunSweepWorker.BATCH)
          .for('update', { skipLocked: true });
        for (const run of rows) {
          await recordOutboxEvent(tx, {
            aggregateType: 'run',
            aggregateId: run.id,
            organizationId: run.organizationId,
            eventType: 'run.created',
            partitionKey: run.conversationId,
            payload: {
              run_id: run.id,
              conversation_id: run.conversationId,
              message_id: run.inputMessageId,
              assistant_version_id: run.assistantVersionId,
              requeued: true,
              sweep_id: uuidv7(),
            },
          });
        }
        return rows.length;
      });
      if (requeued > 0) {
        AcceptedRunSweepWorker.logger.log(`accepted-run sweep requeued ${requeued} run(s) for dispatch`);
      }
    } catch (err) {
      AcceptedRunSweepWorker.logger.warn(`accepted-run sweep failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
