/**
 * MongoDB lane for {@link IAdjustmentRepository} (P3, B-7). Mirrors
 * `PgAdjustmentRepository` method-for-method: signed 6dp amounts, the
 * reason truncated to 1024 chars, pending adjustments (NULL
 * applied_invoice_id) consumed by the draft transaction.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { BillingAdjustmentRow } from './repository-types';
import {
  binUuid,
  requireOrg,
  tenantCollection,
  toAdjustment,
  toFixed6,
  type BillingAdjustmentMongoDoc,
} from './mongo-documents';
import type { CreateAdjustmentInput, IAdjustmentRepository } from './adjustment.repository';

const COLLECTION = 'billing_adjustments';

@Injectable()
export class MongoAdjustmentRepository implements IAdjustmentRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async createAdjustment(input: CreateAdjustmentInput): Promise<BillingAdjustmentRow> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingAdjustmentMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const doc: BillingAdjustmentMongoDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(org),
        product: input.product,
        kind: input.kind,
        amount_usd: toFixed6(input.amountUsd),
        reason: input.reason.slice(0, 1024),
        applied_invoice_id: null,
        created_by: binUuid(input.createdBy, 'createdBy'),
        created_at: new Date().toISOString(),
      };
      await col.insertOne(org, doc, { session: ctx.session });
      return toAdjustment(doc);
    });
  }

  async listAdjustments(orgId: string, product?: string): Promise<BillingAdjustmentRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingAdjustmentMongoDoc>(this.mongo.root, COLLECTION, 'org_id');
      const docs = await col
        .find(org, product ? { product } : {}, { session: ctx.session })
        .toArray();
      return docs.map(toAdjustment);
    });
  }
}
