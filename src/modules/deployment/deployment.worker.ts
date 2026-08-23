import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import { env } from '../../common/config/env';
import { QueueService } from '../../common/infra/queue.service';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EntitlementsService } from '../organizations/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DeploymentWorkflow, RunJobData } from './deployment.workflow';
import { DeploymentsService } from './deployments.service';
import { SecretsService } from './secrets.service';
import { deploymentEvents, deployments } from './schema';

/**
 * The deployment namespace worker (partitioning Tier-1): the SINGLE BullMQ
 * consumer for the `deployment:` queue. It owns the run steps' DLQ
 * handling and the three maintenance rhythms:
 *
 *   deployment.reconcile     (every 60s) — crash-safety net: active runs
 *                              whose row state is older than 2× the max
 *                              expected tick cadence get their step
 *                              re-enqueued. A Redis flush can stall a run;
 *                              this is what un-stalls it.
 *   deployment.retention     (daily 03:20) — the plan's retention_days
 *                              enforced on the deployment_events log (the
 *                              run rows themselves are permanent history).
 *   deployment.secrets_scan  (daily 06:40) — expiring/overdue-rotation
 *                              secrets notify their org (after the keys
 *                              scan, before business hours).
 */
const RECONCILE_STALE_MS = 120_000;
const DEFAULT_RETENTION_DAYS = 365;

@Injectable()
export class DeploymentWorker implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(DeploymentWorker.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly workflow: DeploymentWorkflow,
    private readonly deploymentsService: DeploymentsService,
    private readonly secrets: SecretsService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queues.queue('deployment');
    await queue.add('deployment.reconcile', {}, { repeat: { pattern: '* * * * *' }, removeOnFail: { age: 7 * 86_400 }, removeOnComplete: { age: 86_400 } });
    await queue.add('deployment.retention', {}, { repeat: { pattern: '20 3 * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 30 * 86_400 } });
    await queue.add('deployment.secrets_scan', {}, { repeat: { pattern: '40 6 * * *' }, removeOnFail: { age: 30 * 86_400 }, removeOnComplete: { age: 7 * 86_400 } });

    this.worker = new Worker(
      'deployment:default',
      async (job: Job) => {
        switch (job.name) {
          case 'deployment.run':
            return this.workflow.runStep(job.data as RunJobData);
          case 'deployment.reconcile':
            return this.reconcile();
          case 'deployment.retention':
            return this.retention();
          case 'deployment.secrets_scan':
            return this.secretsScan();
          default:
            DeploymentWorker.logger.warn(`unknown deployment job "${job.name}" — discarding`);
            return undefined;
        }
      },
      { connection: { url: env.REDIS_URL }, concurrency: 4 },
    );
    this.worker.on('failed', async (job, err) => {
      DeploymentWorker.logger.error(`deployment job ${job?.name ?? '?'} failed (attempt ${job?.attemptsMade ?? 0}): ${err.message}`);
      const data = job?.data as RunJobData | undefined;
      if (job && job.name === 'deployment.run' && data?.deploymentId && job.attemptsMade >= 5) {
        await this.workflow.markExhausted(data, err.message);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }

  /** Re-enqueue stalled active runs (the statelessness rule's safety net). */
  private async reconcile(): Promise<number> {
    const stale = await this.deploymentsService.staleActiveRuns(RECONCILE_STALE_MS);
    let resumed = 0;
    for (const deployment of stale) {
      const state = this.deploymentsService.rolloutStateOf(deployment);
      if (state.paused) {
        continue; // paused is an expected stall, not a lost tick
      }
      const step = deployment.status === 'rolling' ? 'rollout' : 'gates';
      await this.workflow.schedule({ orgId: deployment.orgId, deploymentId: deployment.id, step });
      resumed += 1;
    }
    if (resumed > 0) {
      DeploymentWorker.logger.log(`reconcile: re-enqueued ${resumed} stalled run(s)`);
    }
    return resumed;
  }

  /** Enforce plan retention_days on the event log (run rows stay forever). */
  private async retention(): Promise<number> {
    const orgRows = await this.db.withBypass((tx) =>
      tx
        .selectDistinct({ orgId: deployments.orgId })
        .from(deployments),
    );
    let purged = 0;
    for (const { orgId } of orgRows) {
      const rows = await this.entitlements.listForOrg(orgId);
      const row = rows.find((r) => r.product === 'deployment');
      const limits = (row?.limits ?? {}) as Record<string, unknown>;
      const days = typeof limits.retention_days === 'number' && limits.retention_days > 0 ? (limits.retention_days as number) : DEFAULT_RETENTION_DAYS;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const deleted = await this.db.withBypass((tx) =>
        tx
          .delete(deploymentEvents)
          .where(and(eq(deploymentEvents.orgId, orgId), lt(deploymentEvents.createdAt, cutoff)))
          .returning({ id: deploymentEvents.id }),
      );
      if (deleted.length > 0) {
        purged += deleted.length;
        await this.audit.add({
          action: 'deployment.events_purged',
          resourceType: 'deployment',
          resourceId: orgId,
          actorType: 'system',
          actorId: 'system:deployment-worker',
          tenantId: orgId,
          productTag: 'deployment',
          details: { purged: deleted.length, retention_days: days },
        });
      }
    }
    if (purged > 0) {
      DeploymentWorker.logger.log(`retention: purged ${purged} event row(s) across ${orgRows.length} org(s)`);
    }
    return purged;
  }

  /** Expiring/overdue secrets notify their org (once per day per scan). */
  private async secretsScan(): Promise<number> {
    const expiring = await this.secrets.scanExpiring(14);
    const byOrg = new Map<string, typeof expiring>();
    for (const item of expiring) {
      const list = byOrg.get(item.orgId) ?? [];
      list.push(item);
      byOrg.set(item.orgId, list);
    }
    for (const [orgId, items] of byOrg) {
      await this.notifications.notifyOrgRoles(orgId, ['owner', 'admin', 'developer'], {
        kind: 'deployment.secrets_expiring',
        severity: 'warn',
        title: 'Deployment secrets need rotation',
        body: `${items.length} secret(s) expire soon or are past their rotation cadence: ${items.slice(0, 5).map((i) => i.key).join(', ')}${items.length > 5 ? ', …' : ''}.`,
        data: { org_id: orgId, keys: items.slice(0, 20).map((i) => i.key), count: items.length },
      });
    }
    return expiring.length;
  }
}
