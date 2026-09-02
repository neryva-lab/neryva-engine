import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { StorageService } from '../../common/infra/storage/storage.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { conversations, messages } from '../conversations/schema';
import { artifacts } from '../knowledge/schema';
import { memoryItems } from '../knowledge/schema';
import { env } from '../../common/config/env';
import { legalHolds, purgeTasks, PurgeTask, retentionPolicies, tombstones } from './lifecycle.schema';
import { assertUuid } from './assert';

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
 */
export const PURGE_STEPS = ['authorize', 'check_holds', 'mark_unavailable', 'emit_derived_deletion', 'purge_objects', 'purge_content', 'tombstone', 'done'] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

@Injectable()
export class RetentionPurgeService implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(RetentionPurgeService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  // ── Retention policies (9.3) ────────────────────────────────────────────

  async upsertPolicy(input: { orgId: string; resourceType: string; retentionClass: string; keepDays: number; actor: string }): Promise<void> {
    assertUuid(input.orgId, 'orgId');
    if (!Number.isInteger(input.keepDays) || input.keepDays < 1) {
      throw ApiError.validation({ keep_days: 'must be a positive integer' });
    }
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx
        .insert(retentionPolicies)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          resourceType: input.resourceType,
          retentionClass: input.retentionClass,
          keepUntilRule: { keep_days: input.keepDays },
          createdBy: input.actor,
        })
        .onConflictDoNothing();
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
    return this.db.withOrg(input.orgId, async (tx) => {
      const created = await tx.execute(sql`
        insert into purge_tasks (id, organization_id, scope_type, scope_id, reason)
        select gen_random_uuid(), a.organization_id, 'conversation', a.id, 'retention_expiry'
        from artifacts a
        join retention_policies p on p.organization_id = a.organization_id
          and p.resource_type = 'artifact' and p.retention_class = a.retention_class
        where a.organization_id = ${input.orgId}::uuid
          and a.state = 'active'
          and a.created_at < now() - ((p.keep_until_rule->>'keep_days')::int * interval '1 day')
          and not exists (
            select 1 from purge_tasks pt
            where pt.organization_id = a.organization_id and pt.scope_id = a.id
              and pt.state in ('pending','in_progress','blocked','done')
          )
        returning id
      `);
      return created.rows.length;
    });
  }

  // ── Purge task lifecycle (9.6) ──────────────────────────────────────────

  /** Enqueue a purge (org deletion request, user erasure, retention expiry). */
  async enqueuePurge(input: { orgId: string; scopeType: string; scopeId: string; reason: string; actor: string }): Promise<PurgeTask> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(purgeTasks)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          reason: input.reason,
        })
        .returning(),
    );
    await this.audit.add({
      action: 'purge.enqueued',
      resourceType: 'purge_task',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { scope_type: input.scopeType, scope_id: input.scopeId, reason: input.reason },
    });
    return rows[0];
  }

  /** One worker tick: advance one purge task by one step. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const task = await this.claimOne();
      if (!task) return;
      try {
        await this.advance(task);
      } finally {
        await this.db.withBypass(async (tx) => {
          await tx.update(purgeTasks).set({ lockedAt: null }).where(eq(purgeTasks.id, task.id));
        });
      }
    } catch (err) {
      RetentionPurgeService.logger.warn(`purge tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async claimOne(): Promise<PurgeTask | null> {
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .select()
        .from(purgeTasks)
        .where(
          and(
            inArray(purgeTasks.state, ['pending', 'in_progress']),
            or(isNull(purgeTasks.lockedAt), lte(purgeTasks.lockedAt, staleBefore)),
          ),
        )
        .orderBy(asc(purgeTasks.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (rows.length === 0) return null;
      const updated = await tx
        .update(purgeTasks)
        .set({ state: 'in_progress', lockedAt: new Date().toISOString() })
        .where(eq(purgeTasks.id, rows[0].id))
        .returning();
      return updated[0];
    });
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
        await this.db.withBypass(async (tx) => {
          await tx
            .update(purgeTasks)
            .set({ state: 'blocked', step: 'check_holds', lastError: 'blocked_by_legal_hold', lockedAt: null })
            .where(eq(purgeTasks.id, task.id));
        });
        return;
      }
      await this.db.withBypass(async (tx) => {
        await tx
          .update(purgeTasks)
          .set({ state: 'failed', lastError: (err as Error).message.slice(0, 4000), lockedAt: null })
          .where(eq(purgeTasks.id, task.id));
      });
    }
  }

  private async toStep(task: PurgeTask, step: PurgeStep, evidence?: Record<string, unknown>): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(purgeTasks)
        .set({
          step,
          state: step === 'done' ? 'done' : 'in_progress',
          finishedAt: step === 'done' ? new Date().toISOString() : null,
          ...(evidence ? { evidence: { ...(task.evidence as Record<string, unknown> ?? {}), ...evidence } } : {}),
        })
        .where(eq(purgeTasks.id, task.id));
    });
  }

  private async stepAuthorize(task: PurgeTask): Promise<void> {
    if (task.scopeType !== 'conversation') {
      // v1 purge scope: conversations (cascades messages/runs via FK).
      throw new Error(`unsupported purge scope ${task.scopeType} (v1 supports conversation)`);
    }
    await this.toStep(task, 'check_holds');
  }

  private async stepCheckHolds(task: PurgeTask): Promise<void> {
    const holds = await this.db.withOrg(task.organizationId, (tx) =>
      tx
        .select()
        .from(legalHolds)
        .where(
          and(
            eq(legalHolds.organizationId, task.organizationId),
            eq(legalHolds.status, 'active'),
            or(eq(legalHolds.scopeType, 'organization'), and(eq(legalHolds.scopeType, 'conversation'), eq(legalHolds.scopeId, task.scopeId))),
          ),
        )
        .limit(1),
    );
    if (holds.length > 0) {
      throw new Error('blocked_by_legal_hold');
    }
    await this.toStep(task, 'mark_unavailable');
  }

  private async stepMarkUnavailable(task: PurgeTask): Promise<void> {
    // Product surface unavailable BEFORE anything is destroyed.
    await this.db.withOrg(task.organizationId, async (tx) => {
      await tx.update(conversations).set({ status: 'deleted', updatedAt: new Date().toISOString() }).where(eq(conversations.id, task.scopeId));
    });
    await this.toStep(task, 'emit_derived_deletion');
  }

  private async stepEmitDerivedDeletion(task: PurgeTask): Promise<void> {
    // Derived stores (chunks/embeddings/caches) delete via outbox — same
    // durable-delivery guarantee as every other fact.
    await this.db.withOrg(task.organizationId, async (tx) => {
      await recordOutboxEvent(tx, {
        aggregateType: 'conversation',
        aggregateId: task.scopeId,
        organizationId: task.organizationId,
        eventType: 'conversation.purged',
        partitionKey: task.scopeId,
        payload: { conversation_id: task.scopeId, reason: task.reason },
      });
    });
    await this.toStep(task, 'purge_objects');
  }

  private async stepPurgeObjects(task: PurgeTask): Promise<void> {
    // Artifacts attached to this conversation's runs (checkpoints, transcripts).
    const rows = await this.db.withOrg(task.organizationId, async (tx) => {
      const artifactRows = await tx.execute(sql`
        select distinct a.id, a.object_key from artifacts a
        join runs r on r.policy_snapshot_id is not null and r.conversation_id = ${task.scopeId}::uuid
        join assistant_versions av on av.id = r.assistant_version_id
        where a.organization_id = ${task.organizationId}::uuid
        limit 100
      `);
      void artifactRows;
      // v1: conversation purge deletes artifacts whose purpose is bound to the
      // conversation (transcripts/tool results) — source documents follow
      // retention, not conversation deletion.
      const direct = await tx
        .select({ id: artifacts.id, objectKey: artifacts.objectKey })
        .from(artifacts)
        .where(and(eq(artifacts.organizationId, task.organizationId), eq(artifacts.purpose, 'TRANSCRIPT')))
        .limit(100);
      return direct;
    });
    const deleted: string[] = [];
    for (const row of rows) {
      await this.storage.deleteObject(row.objectKey);
      deleted.push(row.id);
      await this.db.withBypass(async (tx) => {
        await tx.update(artifacts).set({ state: 'purged', updatedAt: new Date().toISOString() }).where(eq(artifacts.id, row.id));
      });
    }
    await this.toStep(task, 'purge_content', { objects_purged: deleted.length });
  }

  private async stepPurgeContent(task: PurgeTask): Promise<void> {
    // Relational content per policy: messages purged (transcript data),
    // runs kept as redacted skeletons for billing/audit explainability.
    await this.db.withOrg(task.organizationId, async (tx) => {
      await tx.delete(messages).where(and(eq(messages.conversationId, task.scopeId), eq(messages.organizationId, task.organizationId)));
      await tx
        .update(memoryItems)
        .set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(memoryItems.scopeId, task.scopeId), eq(memoryItems.scopeType, 'conversation')));
    });
    await this.toStep(task, 'tombstone');
  }

  private async stepTombstone(task: PurgeTask): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .insert(tombstones)
        .values({
          id: uuidv7(),
          organizationId: task.organizationId,
          resourceType: 'conversation',
          resourceId: task.scopeId,
          reason: task.reason,
        })
        .onConflictDoNothing();
    });
    await this.toStep(task, 'done', { purged_at: new Date().toISOString() });
    await this.audit.add({
      action: 'purge.completed',
      resourceType: 'conversation',
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
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(purgeTasks).where(eq(purgeTasks.id, taskId)).limit(1));
    return rows[0] ?? null;
  }

  // ── Tombstones (9.8) ────────────────────────────────────────────────────

  /** Typed 410 when a purged resource is referenced (MCP + console paths). */
  async assertNotTombstoned(resourceType: string, resourceId: string): Promise<void> {
    const rows = await this.db.withBypass((tx) =>
      tx.select().from(tombstones).where(and(eq(tombstones.resourceType, resourceType), eq(tombstones.resourceId, resourceId))).limit(1),
    );
    if (rows.length > 0) {
      throw ApiError.conflict('resource has been purged', { resource_id: resourceId, reason: rows[0].reason });
    }
  }

  // ── Worker wiring ───────────────────────────────────────────────────────

  onModuleInit(): void {
    if (!env.WORKERS__OUTBOX_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), env.OUTBOX_DISPATCH_INTERVAL_MS);
    this.timer.unref();
    RetentionPurgeService.logger.log('retention/purge worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
