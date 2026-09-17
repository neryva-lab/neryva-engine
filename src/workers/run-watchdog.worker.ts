import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { ConversationsService } from '../modules/conversations/conversations.service';
import { env } from '../common/config/env';

/**
 * Run watchdog — P2 (ai-native-review.md streaming breaker, engine half).
 *
 * The Studio holds the provider socket, so the engine cannot sever TCP
 * mid-stream. What it CAN do is fail the run closed the moment its declared
 * wall-clock budget is spent: RUNNING/DISPATCHED runs older than their
 * pinned `budget_policy.wall_clock_seconds` flip to FAILED
 * (`budget_exceeded_wall_clock`) with quota released, a terminal run event
 * (SSE readers see the closure), and a `run.failed` outbox event. The
 * Studio's lease checks then fail on the terminal row — execution stops
 * spending even if the provider stream is still open.
 *
 * Scope rules (load-bearing):
 * - only budgets that DECLARE wall_clock_seconds > 0 (unset/0 = no watchdog;
 *   inventing a global kill would change every org's posture silently);
 * - RUNNING + DISPATCHED only (WAITING_* burns no tokens; approval expiry
 *   governs parked runs);
 * - lifetime measured from ACCEPT (accepted_at), not dispatch — the budget
 *   guards total run lifetime, queueing included;
 * - per-candidate isolation: one failure never starves the batch.
 */
@Injectable()
export class RunWatchdogWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(RunWatchdogWorker.name);
  private static readonly BATCH = 50;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
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

  /**
   * @param orgId test seam ONLY (integration hermeticity): production calls
   * tick() unfiltered and sweeps every org. Scoping the sweep in a test to
   * its own org keeps the global worker honest without failing runs that
   * belong to other tests, sessions, or developers sharing the database.
   */
  async tick(orgId?: string): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const candidates = await this.db.withBypass(async (tx) => {
        const rows = await tx.execute(sql`
          select r.id as run_id, r.organization_id as org_id
          from runs r
          join policy_snapshots ps on ps.id = r.policy_snapshot_id
          where r.state in ('RUNNING', 'DISPATCHED')
            and coalesce((ps.budget_policy->>'wall_clock_seconds')::int, 0) > 0
            and r.accepted_at < now() - ((ps.budget_policy->>'wall_clock_seconds')::int || ' seconds')::interval
            ${orgId === undefined ? sql`` : sql`and r.organization_id = ${orgId}::uuid`}
          limit ${RunWatchdogWorker.BATCH}
          for update of r skip locked
        `);
        return rows.rows as Array<{ run_id: string; org_id: string }>;
      });
      let failed = 0;
      for (const candidate of candidates) {
        try {
          await this.conversations.failRunForBudget({
            orgId: candidate.org_id,
            runId: candidate.run_id,
            reason: 'budget_exceeded_wall_clock',
            actor: 'system:run-watchdog',
          });
          failed += 1;
        } catch (err) {
          RunWatchdogWorker.logger.warn(
            `watchdog deferring run ${candidate.run_id}: ${(err as Error).message}`,
          );
        }
      }
      if (failed > 0) {
        RunWatchdogWorker.logger.log(`run watchdog failed ${failed} run(s) for wall-clock breach`);
      }
    } catch (err) {
      RunWatchdogWorker.logger.warn(`run watchdog tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
