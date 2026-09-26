/**
 * MongoDB lane for {@link IBudgetRepository} (P3, B-3). Mirrors
 * `PgBudgetRepository` method-for-method: monthly amounts are 2dp
 * strings, `deleteBudget` reports existence, `listAllBudgets` is the
 * explicitly cross-tenant worker read (bypass), and
 * `markBudgetNotified` records the highest threshold notified this
 * cycle.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { BillingBudgetRow } from './repository-types';
import {
  binUuid,
  requireOrg,
  tenantCollection,
  toBudget,
  type BillingBudgetMongoDoc,
} from './mongo-documents';
import type { CreateBudgetInput, IBudgetRepository } from './budget.repository';

const COLLECTION = 'billing_budgets';

@Injectable()
export class MongoBudgetRepository implements IBudgetRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async createBudget(input: CreateBudgetInput): Promise<BillingBudgetRow> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingBudgetMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const doc: BillingBudgetMongoDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(org),
        product: input.product ?? null,
        project_id: input.projectId ? binUuid(input.projectId, 'projectId') : null,
        name: 'Monthly budget',
        monthly_usd: input.monthlyUsd.toFixed(2),
        thresholds: input.thresholds,
        notified_percent: 0,
        notified_cycle: null,
        created_by: binUuid(input.createdBy, 'createdBy'),
        created_at: new Date().toISOString(),
      };
      await col.insertOne(org, doc, { session: ctx.session });
      return toBudget(doc);
    });
  }

  async listBudgets(orgId: string): Promise<BillingBudgetRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingBudgetMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const docs = await col.find(org, {}, { session: ctx.session }).toArray();
      return docs.map(toBudget);
    });
  }

  async deleteBudget(orgId: string, budgetId: string): Promise<boolean> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingBudgetMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const result = await col.deleteOne(org, { id: binUuid(budgetId, 'budgetId') }, { session: ctx.session });
      return result.deletedCount > 0;
    });
  }

  async listAllBudgets(): Promise<BillingBudgetRow[]> {
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.mongo.root
        .collection<BillingBudgetMongoDoc>(COLLECTION)
        .find({}, { session: ctx.session })
        .toArray();
      return docs.map(toBudget);
    });
  }

  async markBudgetNotified(orgId: string, budgetId: string, percent: number, cycle: string): Promise<void> {
    await this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingBudgetMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      await col.updateOne(
        org,
        { id: binUuid(budgetId, 'budgetId') },
        { $set: { notified_percent: percent, notified_cycle: cycle } },
        { session: ctx.session },
      );
    });
  }
}
