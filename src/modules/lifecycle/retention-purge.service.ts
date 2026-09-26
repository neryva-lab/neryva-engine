import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { StorageService } from '../../common/infra/storage/storage.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ERROR_CODES } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { PurgeTask } from './lifecycle.schema';
import { assertUuid } from './assert';
import {
  PURGE_STEPS,
  type IPurgeTaskRepository,
  type PurgeStep,
} from './repositories/purge-task.repository';
import { PURGE_TASK_REPOSITORY } from './repositories/repository-tokens';
import { type IPurgeStepRepository } from './repositories/purge-step.repository';
import { PURGE_STEP_REPOSITORY } from './repositories/repository-tokens';
import { type IRetentionPolicyRepository } from './repositories/retention-policy.repository';
import { RETENTION_POLICY_REPOSITORY } from './repositories/repository-tokens';

/**
 * Retention + purge — Phase 9.3/9.4/9.6/9.8 (ledger). Deletion is a WORKFLOW,
 * not a DELETE statement. The pinned order (engine_data_and_lifecycle.md:374):
 *
 *   authorize → check legal_hold/retention → mark product/search unavailable →
 *   emit derived-store deletion via outbox → purge caches+indexes →
 *   purge objects → purge/redact relational content → tombstone + evidence
 *
 * Each step advances one `purge_tasks.step` per claim; a crash resumes from
 * the persisted step. An active legal hold BLOCKS the purge (state=blocked)
 * while unrelated retention work continues. After `tombstone`, stale IDs are
 * rejected with typed 410s (Tombstones.assertNotTombstoned).
 *
 * Persistence goes through the P3 repository ports (`IPurgeTaskRepository`,
 * `IPurgeStepRepository`, `IRetentionPolicyRepository`) — the concrete
 * implementation is selected by `DB_PROVIDER` in
 * `LifecycleRepositoriesModule`. This service is provider-blind: no drizzle,
 * no mongo driver, no provider conditionals.
 */
export { PURGE_STEPS };
export type { PurgeStep };

/** Retention sweep cadence: hourly. Sweep only creates purge tasks; the purge
 * worker's tick advances them, so a sweep is cheap and idempotent. */
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class RetentionPurgeService implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(RetentionPurgeService.name);
  private timer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(PURGE_TASK_REPOSITORY) private readonly purgeTasks: IPurgeTaskRepository,
    @Inject(PURGE_STEP_REPOSITORY) private readonly purgeSteps: IPurgeStepRepository,
    @Inject(RETENTION_POLICY_REPOSITORY) private readonly retentionPolicies: IRetentionPolicyRepository,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Retention policies (9.3) ────────────────────────────────────────────

  async upsertPolicy(input: { orgId: string; resourceType: string; retentionClass: string; keepDays: number; actor: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    if (!Number.isInteger(input.keepDays) || input.keepDays < 1) {
      throw ApiError.validation({ keep_days: 'must be a positive integer' });
    }
    await this.retentionPolicies.upsertPolicy({
      orgId: input.orgId,
      resourceType: input.resourceType,
      retentionClass: input.retentionClass,
      keepDays: input.keepDays,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'retention.policy_upserted',
      resourceType: 'retention_policy',
      resourceId: input.resourceType,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { retention_class: input.retentionClass, keep_days: input.keepDays },
    });
  }

  /** Sweep: create purge tasks for artifacts past their keep_until window. */
  async sweepRetention(input: { orgId: string }): Promise<number> {
    assertUuid(input.orgId, 'orgId');
    return this.retentionPolicies.sweepArtifactRetention(input.orgId);
  }

  /**
   * Conversation retention sweep: orgs that set `tenants.retention_days` get
   * purge tasks for conversations older than the window. Null retention_days
   * means keep indefinitely — no automatic deletion. Legal holds still gate
   * every task at the check_holds step; a task is never created twice while
   * one is pending/in_progress/blocked/done.
   */
  async sweepConversationRetention(input: { orgId: string }): Promise<number> {
    assertUuid(input.orgId, 'orgId');
    return this.retentionPolicies.sweepConversationRetention(input.orgId);
  }

  /**
   * Hourly retention sweep across every org (P2-COMP-10: sweepRetention had no
   * non-test caller, so retention policies never fired). Runs both the
   * artifact sweep and the conversation-retention sweep; per-org failures are
   * logged and do not stop the sweep.
   */
  async sweepAllRetention(): Promise<void> {
    try {
      const tenantIds = await this.retentionPolicies.listTenantIds();
      let created = 0;
      for (const orgId of tenantIds) {
        try {
          created += await this.sweepRetention({ orgId });
          created += await this.sweepConversationRetention({ orgId });
        } catch (err) {
          RetentionPurgeService.logger.warn(`retention sweep failed for org ${orgId}: ${(err as Error).message}`);
        }
      }
      if (created > 0) {
        RetentionPurgeService.logger.log(`retention sweep created ${created} purge tasks`);
      }
    } catch (err) {
      RetentionPurgeService.logger.warn(`retention sweep failed: ${(err as Error).message}`);
    }
  }

  // ── Purge task lifecycle (9.6) ──────────────────────────────────────────

  /** Enqueue a purge (org deletion request, user erasure, retention expiry). */
  async enqueuePurge(input: { orgId: string; scopeType: string; scopeId: string; reason: string; actor: string }): Promise<PurgeTask> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    const task = await this.purgeTasks.enqueuePurge({
      orgId: input.orgId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      reason: input.reason,
    });
    await this.audit.add({
      action: 'purge.enqueued',
      resourceType: 'purge_task',
      resourceId: task.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { scope_type: input.scopeType, scope_id: input.scopeId, reason: input.reason },
    });
    return task;
  }

  /** One worker tick: advance one purge task by one step. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const task = await this.purgeTasks.claimOne();
      if (!task) return;
      try {
        await this.advance(task);
      } finally {
        await this.purgeTasks.unlock(task.id);
      }
    } catch (err) {
      RetentionPurgeService.logger.warn(`purge tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async advance(task: PurgeTask): Promise<void> {
    try {
      switch (task.step as PurgeStep) {
        case 'authorize':
          await this.stepAuthorize(task);
          return;
        case 'check_holds':
          await this.stepCheckHolds(task);
          return;
        case 'mark_unavailable':
          await this.stepMarkUnavailable(task);
          return;
        case 'emit_derived_deletion':
          await this.stepEmitDerivedDeletion(task);
          return;
        case 'purge_objects':
          await this.stepPurgeObjects(task);
          return;
        case 'purge_content':
          await this.stepPurgeContent(task);
          return;
        case 'tombstone':
          await this.stepTombstone(task);
          return;
        default:
          return;
      }
    } catch (err) {
      if ((err as Error).message === 'blocked_by_legal_hold') {
        await this.purgeTasks.markBlocked(task.id);
        return;
      }
      await this.purgeTasks.markFailed(task.id, (err as Error).message);
    }
  }

  private async toStep(task: PurgeTask, step: PurgeStep, evidence?: Record<string, unknown>): Promise<void> {
    await this.purgeTasks.advanceStep(task, step, evidence);
  }

  private async stepAuthorize(task: PurgeTask): Promise<void> {
    if (task.scopeType !== 'conversation' && task.scopeType !== 'artifact') {
      throw new Error(`unsupported purge scope ${task.scopeType} (v1 supports conversation, artifact)`);
    }
    await this.toStep(task, 'check_holds');
  }

  private async stepCheckHolds(task: PurgeTask): Promise<void> {
    const blocked = await this.purgeSteps.findBlockingHold(task.organizationId, task.scopeType, task.scopeId);
    if (blocked) {
      throw new Error('blocked_by_legal_hold');
    }
    await this.toStep(task, 'mark_unavailable');
  }

  private async stepMarkUnavailable(task: PurgeTask): Promise<void> {
    // Product surface unavailable BEFORE anything is destroyed. Artifacts use
    // the DDL-sanctioned 'retiring' state (chk_artifacts_state).
    await this.purgeSteps.markUnavailable({
      orgId: task.organizationId,
      scopeType: task.scopeType as 'conversation' | 'artifact',
      scopeId: task.scopeId,
    });
    await this.toStep(task, 'emit_derived_deletion');
  }

  private async stepEmitDerivedDeletion(task: PurgeTask): Promise<void> {
    // Derived stores (chunks/embeddings/caches) delete via outbox — same
    // durable-delivery guarantee as every other fact (invariant 7: the outbox
    // write happens in the same unit of work as the fact it announces, owned
    // by the repository implementation).
    await this.purgeSteps.emitDerivedDeletion({
      orgId: task.organizationId,
      scopeType: task.scopeType,
      scopeId: task.scopeId,
      reason: task.reason,
    });
    await this.toStep(task, 'purge_objects');
  }

  private static readonly OBJECT_BATCH = 100;

  private async stepPurgeObjects(task: PurgeTask): Promise<void> {
    const rows = await this.purgeSteps.listPurgeableObjects({
      orgId: task.organizationId,
      scopeType: task.scopeType as 'conversation' | 'artifact',
      scopeId: task.scopeId,
      limit: RetentionPurgeService.OBJECT_BATCH,
    });
    for (const row of rows) {
      await this.storage.deleteObject(row.objectKey);
      await this.purgeSteps.markObjectPurged(row.id);
    }
    if (rows.length === RetentionPurgeService.OBJECT_BATCH) {
      // Batch drained — leave the step at purge_objects; the next tick
      // deletes the next batch (re-entrant, idempotent: purged rows no
      // longer match the state filter).
      return;
    }
    await this.toStep(task, 'purge_content', { objects_purged: rows.length });
  }

  private async stepPurgeContent(task: PurgeTask): Promise<void> {
    if (task.scopeType === 'conversation') {
      // Relational content per policy: messages purged (transcript data),
      // runs kept as redacted skeletons for billing/audit explainability.
      await this.purgeSteps.purgeConversationContent(task.organizationId, task.scopeId);
    }
    // artifact scope: no relational content beyond the artifact row itself.
    await this.toStep(task, 'tombstone');
  }

  private async stepTombstone(task: PurgeTask): Promise<void> {
    await this.purgeSteps.writeTombstone({
      orgId: task.organizationId,
      scopeType: task.scopeType,
      scopeId: task.scopeId,
      reason: task.reason,
    });
    await this.toStep(task, 'done', { purged_at: new Date().toISOString() });
    await this.audit.add({
      action: 'purge.completed',
      resourceType: task.scopeType,
      resourceId: task.scopeId,
      actorType: 'service',
      actorId: 'lifecycle-worker',
      tenantId: task.organizationId,
      details: { reason: task.reason },
    });
  }

  async getPurgeTask(orgId: string, taskId: string): Promise<PurgeTask | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(taskId, 'taskId');
    return this.purgeTasks.getPurgeTask(orgId, taskId);
  }

  // ── Tombstones (9.8) ────────────────────────────────────────────────────

  /** Typed 410 when a purged resource is referenced (MCP + console paths). */
  async assertNotTombstoned(resourceType: string, resourceId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resourceId)) {
      return; // non-uuid ids can never be tombstoned
    }
    const tombstone = await this.purgeSteps.findTombstone(resourceType, resourceId);
    if (tombstone) {
      throw new ApiError(410, ERROR_CODES.RESOURCE_PURGED, 'resource has been purged', { resource_id: resourceId, reason: tombstone.reason });
    }
  }

  // ── Worker wiring ───────────────────────────────────────────────────────

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), env.OUTBOX_DISPATCH_INTERVAL_MS);
    this.timer.unref();
    this.retentionTimer = setInterval(() => void this.sweepAllRetention(), RETENTION_SWEEP_INTERVAL_MS);
    this.retentionTimer.unref();
    RetentionPurgeService.logger.log('retention/purge worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
  }
}
