/**
 * PostgreSQL lane for `IPurgeTaskRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/retention-purge.service.ts`
 * (`enqueuePurge` / `claimOne` / the `tick` unlock / `toStep` / the
 * `advance` catch's blocked+failed marking / `getPurgeTask`).
 * Byte-identical behavior, same transaction boundaries, same error
 * semantics — the queries moved here mechanically; no logic changed.
 */
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { purgeTasks } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { IPurgeTaskRepository, PurgeStep } from './purge-task.repository';

@Injectable()
export class PgPurgeTaskRepository implements IPurgeTaskRepository {
  constructor(private readonly db: DbService) {}

  async enqueuePurge(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<typeof purgeTasks.$inferSelect> {
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
    return rows[0];
  }

  async claimOne(): Promise<typeof purgeTasks.$inferSelect | null> {
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

  async unlock(taskId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.update(purgeTasks).set({ lockedAt: null }).where(eq(purgeTasks.id, taskId));
    });
  }

  async advanceStep(
    task: typeof purgeTasks.$inferSelect,
    step: PurgeStep,
    evidence?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(purgeTasks)
        .set({
          step,
          state: step === 'done' ? 'done' : 'in_progress',
          finishedAt: step === 'done' ? new Date().toISOString() : null,
          ...(evidence ? { evidence: { ...((task.evidence as Record<string, unknown> | null) ?? {}), ...evidence } } : {}),
        })
        .where(eq(purgeTasks.id, task.id));
    });
  }

  async markBlocked(taskId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(purgeTasks)
        .set({ state: 'blocked', step: 'check_holds', lastError: 'blocked_by_legal_hold', lockedAt: null })
        .where(eq(purgeTasks.id, taskId));
    });
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(purgeTasks)
        .set({ state: 'failed', lastError: error.slice(0, 4000), lockedAt: null })
        .where(eq(purgeTasks.id, taskId));
    });
  }

  async getPurgeTask(orgId: string, taskId: string): Promise<typeof purgeTasks.$inferSelect | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(taskId, 'taskId');
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(purgeTasks).where(eq(purgeTasks.id, taskId)).limit(1),
    );
    return rows[0] ?? null;
  }
}
