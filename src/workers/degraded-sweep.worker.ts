import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AssistantsService } from '../modules/assistants/assistants.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { env } from '../common/config/env';

/**
 * Degraded-lifecycle sweep — P5 (ai-native-review.md degraded TTL).
 *
 * Publish-with-bypass starts a 7-day clock (assistants.degraded_until).
 * Every minute this sweep:
 * - suspends overdue assistants (still degraded past TTL, still enabled)
 *   through the disable path (reversible; banner keeps the degraded reason);
 * - warns owners 24h before expiry (once — degraded_alerted_at marks it).
 * State transitions live in AssistantsService.sweepDegradedAssistants (one
 * audited transaction each); this worker only fans out notifications.
 * Alerting never throws (notification plane degrades independently).
 */
@Injectable()
export class DegradedSweepWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(DegradedSweepWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly assistants: AssistantsService,
    private readonly notifications: NotificationsService,
  ) {}

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

  async tick(orgId?: string): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { suspended, dueSoon } = await this.assistants.sweepDegradedAssistants({ orgId });
      for (const item of dueSoon) {
        try {
          await this.notifications.notifyOrgRoles(item.orgId, ['owner', 'admin'], {
            kind: 'assistant.degraded',
            severity: 'warn',
            title: `Degraded knowledge on ${item.name} expires in 24h`,
            body: 'The publish waiver for unresolved knowledge expires within 24 hours — fix the pins and re-publish, or the agent auto-suspends.',
            data: { assistant_id: item.assistantId },
            email: true,
          });
        } catch (err) {
          DegradedSweepWorker.logger.warn(
            `degraded warning fan-out failed for ${item.assistantId}: ${(err as Error).message}`,
          );
        }
      }
      for (const item of suspended) {
        try {
          await this.notifications.notifyOrgRoles(item.orgId, ['owner', 'admin'], {
            kind: 'assistant.degraded_suspended',
            severity: 'error',
            title: `${item.name} auto-suspended: degraded knowledge unresolved`,
            body: 'The 7-day publish waiver expired with pins still unresolved, so the agent was suspended. Fix the knowledge and re-enable it.',
            data: { assistant_id: item.assistantId },
            email: true,
          });
        } catch (err) {
          DegradedSweepWorker.logger.warn(
            `suspension fan-out failed for ${item.assistantId}: ${(err as Error).message}`,
          );
        }
      }
      if (suspended.length > 0 || dueSoon.length > 0) {
        DegradedSweepWorker.logger.log(
          `degraded sweep: ${suspended.length} suspended, ${dueSoon.length} warned`,
        );
      }
    } catch (err) {
      DegradedSweepWorker.logger.warn(`degraded sweep tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
