/**
 * MongoDB lane for `IPurgeTaskRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/retention-purge.service.ts`.
 * Platform-plane (`withBypass` — `PlatformCollection`, no tenant
 * predicate): the worker advances tasks across tenants. UUIDs are BSON
 * Binary subtype 4 (plan D4), timestamps are ISO-8601 strings.
 *
 * `claimOne` replaces the pg `SELECT ... FOR UPDATE SKIP LOCKED` with an
 * atomic `findOneAndUpdate` on the oldest claimable task — the claim and
 * the `in_progress` + `lockedAt` stamp are one operation, so concurrent
 * workers never claim the same task twice.
 */
import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { PlatformCollection } from '../../../common/infra/db/mongo/concurrency';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { PurgeTask } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { IPurgeTaskRepository, PurgeStep } from './purge-task.repository';
import { toPurgeTask, type PurgeTaskMongoDoc } from './mongo-lifecycle-documents';

@Injectable()
export class MongoPurgeTaskRepository implements IPurgeTaskRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tasks(db: Db): PlatformCollection<PurgeTaskMongoDoc> {
    return new PlatformCollection<PurgeTaskMongoDoc>(db.collection<PurgeTaskMongoDoc>('purge_tasks'));
  }

  async enqueuePurge(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<PurgeTask> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.scopeId, 'scopeId');
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const tasks = this.tasks(db);
      const id = uuidv7();
      const now = new Date().toISOString();
      await tasks.insertOne(
        {
          id: uuidToBinary(id),
          organization_id: uuidToBinary(input.orgId),
          scope_type: input.scopeType,
          scope_id: uuidToBinary(input.scopeId),
          reason: input.reason,
          state: 'pending',
          step: 'authorize',
          last_error: null,
          evidence: null,
          locked_at: null,
          created_at: now,
          finished_at: null,
        },
        { session: ctx.session },
      );
      const saved = await tasks.findOne({ id: uuidToBinary(id) }, { session: ctx.session });
      if (!saved) {
        throw new Error('purge task insert produced no row');
      }
      return toPurgeTask(saved);
    });
  }

  async claimOne(): Promise<PurgeTask | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const tasks = this.tasks(db);
      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
      const now = new Date().toISOString();
      // Atomic claim of the oldest claimable task (pending, or in_progress
      // with a stale lock) — the mongo equivalent of FOR UPDATE SKIP LOCKED.
      const claimed = await tasks.findOneAndUpdate(
        {
          state: { $in: ['pending', 'in_progress'] },
          $or: [{ locked_at: null }, { locked_at: { $lte: staleBefore } }],
        },
        { $set: { state: 'in_progress', locked_at: now } },
        { session: ctx.session, sort: { created_at: 1 }, returnDocument: 'after' },
      );
      return claimed ? toPurgeTask(claimed) : null;
    });
  }

  async unlock(taskId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      await this.tasks(db).updateOne(
        { id: uuidToBinary(taskId) },
        { $set: { locked_at: null } },
        { session: ctx.session },
      );
    });
  }

  async advanceStep(
    task: PurgeTask,
    step: PurgeStep,
    evidence?: Record<string, unknown>,
  ): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const base = (task.evidence as Record<string, unknown> | null) ?? {};
      await this.tasks(db).updateOne(
        { id: uuidToBinary(task.id) },
        {
          $set: {
            step,
            state: step === 'done' ? 'done' : 'in_progress',
            finished_at: step === 'done' ? new Date().toISOString() : null,
            ...(evidence ? { evidence: { ...base, ...evidence } } : {}),
          },
        },
        { session: ctx.session },
      );
    });
  }

  async markBlocked(taskId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      await this.tasks(db).updateOne(
        { id: uuidToBinary(taskId) },
        {
          $set: {
            state: 'blocked',
            step: 'check_holds',
            last_error: 'blocked_by_legal_hold',
            locked_at: null,
          },
        },
        { session: ctx.session },
      );
    });
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      await this.tasks(db).updateOne(
        { id: uuidToBinary(taskId) },
        { $set: { state: 'failed', last_error: error.slice(0, 4000), locked_at: null } },
        { session: ctx.session },
      );
    });
  }

  async getPurgeTask(orgId: string, taskId: string): Promise<PurgeTask | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(taskId, 'taskId');
    const db = this.mongo.root;
    // Tenant-scoped read of a platform-plane row: the predicate is explicit
    // here (the worker's claim path stays unscoped).
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const doc = await this.tasks(db).findOne(
        { id: uuidToBinary(taskId), organization_id: uuidToBinary(orgId) },
        { session: ctx.session },
      );
      return doc ? toPurgeTask(doc) : null;
    });
  }
}
