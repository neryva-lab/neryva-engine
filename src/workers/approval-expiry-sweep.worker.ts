import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { McpAuthorityService } from '../modules/conversations/mcp-authority.service';
import { env } from '../common/config/env';

/**
 * Approval-expiry sweep — Wave 4 workstream 3 (GAP 1).
 *
 * An approval parked past its `expires_at` without a decision must fail
 * closed: approval → EXPIRED, the parked run → CANCELED with
 * `terminal_reason = 'approval_expired'`, and the quota hold settled. The
 * state transitions live in `McpAuthorityService.sweepExpiredApprovals`
 * (audited, transactional, idempotent); this worker only enumerates the orgs
 * with overdue approvals and fans out per org.
 *
 * The org enumeration is a read-only bypass query; concurrent replicas (or
 * this sweep and a just-arrived decision) are safe because the claim inside
 * the per-org settlement is `FOR UPDATE SKIP LOCKED` and only fires on
 * approvals still PENDING. A tick never throws — a dead sweep must not take
 * the worker host down with it.
 */
@Injectable()
export class ApprovalExpirySweepWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(ApprovalExpirySweepWorker.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DbService,
    private readonly authority: McpAuthorityService,
  ) {}

  onModuleInit(): void {
    // Consistent with every other worker on this host (outbox-dispatcher,
    // accepted-run-sweep, run-watchdog, ...): the worker host is the outbox
    // deployment, so no interval worker starts when it is disabled. The sweep
    // writes `run.canceled` outbox events that only the dispatcher delivers —
    // terminalizing runs without a live dispatcher would strand them.
    if (!env.WORKERS__OUTBOX_ENABLED || !env.WORKERS__APPROVAL_EXPIRY_ENABLED) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), env.WORKERS__APPROVAL_EXPIRY_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const orgRows = await this.db.withBypass((tx) =>
        tx.execute(sql`
          select distinct organization_id::text as org_id
          from approvals
          where state = 'PENDING' and expires_at <= now()
          limit 500
        `),
      );
      let expiredTotal = 0;
      let terminalizedTotal = 0;
      for (const orgRow of orgRows.rows as Array<{ org_id: string }>) {
        try {
          const result = await this.authority.sweepExpiredApprovals({
            orgId: orgRow.org_id,
            batchSize: env.WORKERS__APPROVAL_EXPIRY_BATCH_SIZE,
          });
          expiredTotal += result.sweptApprovals.length;
          terminalizedTotal += result.canceledRuns.length;
        } catch (err: unknown) {
          ApprovalExpirySweepWorker.logger.warn(
            `approval-expiry sweep failed for org ${orgRow.org_id}: ${(err as Error).message}`,
          );
        }
      }
      if (expiredTotal > 0) {
        ApprovalExpirySweepWorker.logger.log(
          `approval-expiry sweep: ${expiredTotal} approval(s) expired, ${terminalizedTotal} run(s) canceled`,
        );
      }
    } catch (err: unknown) {
      ApprovalExpirySweepWorker.logger.warn(`approval-expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
