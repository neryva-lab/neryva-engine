/**
 * MongoDB lane for `ILegalHoldRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/lifecycle.service.ts`.
 * Every method is one `withOrg` unit (multi-document transaction, majority
 * concern — plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` on every access (plan D6). UUIDs are BSON Binary
 * subtype 4 (plan D4), timestamps are ISO-8601 strings.
 *
 * `releaseHold` is the same CAS as pg: `findOneAndUpdate` with
 * `status: 'active'` in the filter — only one concurrent release wins; the
 * loser sees null → `notFound('active legal hold')`. The blocked-task re-arm
 * runs in a second `withBypass` unit, mirroring the pg two-transaction
 * shape.
 */
import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { LegalHold } from '../lifecycle.schema';
import { assertUuid } from '../assert';
import type { ILegalHoldRepository } from './legal-hold.repository';
import {
  requireOrg,
  toLegalHold,
  type LegalHoldMongoDoc,
  type PurgeTaskMongoDoc,
} from './mongo-lifecycle-documents';

@Injectable()
export class MongoLegalHoldRepository implements ILegalHoldRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db) {
    return {
      holds: new TenantScopedCollection<LegalHoldMongoDoc>(db.collection<LegalHoldMongoDoc>('legal_holds')),
      tasksBypass: new PlatformCollection<PurgeTaskMongoDoc>(db.collection<PurgeTaskMongoDoc>('purge_tasks')),
    };
  }

  async placeHold(input: {
    orgId: string;
    scopeType: string;
    scopeId: string | null;
    reason: string;
    actor: string;
    expiresAt?: Date;
  }): Promise<LegalHold> {
    assertUuid(input.orgId, 'orgId');
    if (input.scopeId) assertUuid(input.scopeId, 'scopeId');
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const orgId = requireOrg(ctx);
      const { holds } = this.collections(db);
      const id = uuidv7();
      const now = new Date().toISOString();
      await holds.insertOne(
        orgId,
        {
          id: uuidToBinary(id),
          organization_id: uuidToBinary(orgId),
          scope_type: input.scopeType,
          scope_id: input.scopeId ? uuidToBinary(input.scopeId) : null,
          hold_reason: input.reason.slice(0, 512),
          placed_by: input.actor,
          status: 'active',
          placed_at: now,
          released_at: null,
          expires_at: input.expiresAt?.toISOString() ?? null,
        },
        { session: ctx.session },
      );
      const saved = await holds.findOne(orgId, { id: uuidToBinary(id) }, { session: ctx.session });
      if (!saved) {
        throw ApiError.internal();
      }
      return toLegalHold(saved);
    });
  }

  async releaseHold(input: { orgId: string; holdId: string; actor: string }): Promise<LegalHold> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.holdId, 'holdId');
    const db = this.mongo.root;
    const hold = await this.mongo.withOrg(input.orgId, async (ctx: MongoTxContext) => {
      const orgId = requireOrg(ctx);
      const { holds } = this.collections(db);
      const now = new Date().toISOString();
      // CAS: only an active hold transitions — concurrent releases resolve
      // to exactly one winner.
      const updated = await holds.findOneAndUpdate(
        orgId,
        { id: uuidToBinary(input.holdId), status: 'active' },
        { $set: { status: 'released', released_at: now } },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!updated) {
        throw ApiError.notFound('active legal hold');
      }
      return toLegalHold(updated);
    });
    // Re-arm purges this hold was blocking (second unit — mirrors the pg
    // withOrg-then-withBypass shape). Scope predicate mirrors
    // findBlockingHold: org-wide holds cover every task in the org, scoped
    // holds cover their exact (scopeType, scopeId).
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const { tasksBypass } = this.collections(db);
      const filter: Record<string, unknown> = {
        organization_id: uuidToBinary(input.orgId),
        state: 'blocked',
      };
      if (hold.scopeType !== 'organization' && hold.scopeId !== null) {
        filter['scope_type'] = hold.scopeType;
        filter['scope_id'] = uuidToBinary(hold.scopeId);
      }
      await tasksBypass.updateMany(
        filter as never,
        { $set: { state: 'in_progress', step: 'check_holds', last_error: null, locked_at: null } },
        { session: ctx.session },
      );
    });
    return hold;
  }

  async listHolds(orgId: string): Promise<LegalHold[]> {
    assertUuid(orgId, 'orgId');
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx: MongoTxContext) => {
      const tenantId = requireOrg(ctx);
      const { holds } = this.collections(db);
      const docs = await holds
        .find(tenantId, {}, { session: ctx.session, sort: { placed_at: -1 }, limit: 100 })
        .toArray();
      return docs.map(toLegalHold);
    });
  }
}
