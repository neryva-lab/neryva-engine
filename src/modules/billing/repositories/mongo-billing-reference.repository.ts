/**
 * MongoDB lane for {@link IBillingReferenceRepository} (P3). Mirrors
 * `PgBillingReferenceRepository`: the cross-domain reads over the
 * organizations/legacy plane (`tenants`, `projects`,
 * `product_entitlements`). All three reads are deliberately global (no
 * tenant scope) — they answer "does this id exist / who owns it" for the
 * ingest pre-check and the cross-tenant trial sweep.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  binUuid,
  uuidOf,
  type ProductEntitlementMongoDoc,
  type ProjectMongoDoc,
  type TenantMongoDoc,
} from './mongo-documents';
import type {
  ExpiredTrialRow,
  IBillingReferenceRepository,
  ProjectOwnershipRow,
} from './billing-reference.repository';

@Injectable()
export class MongoBillingReferenceRepository implements IBillingReferenceRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async findTenantIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const db = this.mongo.root;
    const docs = await db
      .collection<TenantMongoDoc>('tenants')
      .find({ id: { $in: ids } })
      .project({ id: 1 })
      .toArray();
    return docs.map((d) => d.id);
  }

  async findProjectsByIds(ids: string[]): Promise<ProjectOwnershipRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const db = this.mongo.root;
    const docs = await db
      .collection<ProjectMongoDoc>('projects')
      .find({ id: { $in: ids.map((id) => binUuid(id, 'id')) } })
      .project({ id: 1, org_id: 1 })
      .toArray();
    return docs.map((d) => ({ id: uuidOf(d.id), orgId: d.org_id }));
  }

  async findExpiredTrials(nowIso: string): Promise<ExpiredTrialRow[]> {
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.mongo.root
        .collection<ProductEntitlementMongoDoc>('product_entitlements')
        .find(
          { status: 'trial', period_end: { $ne: null, $lt: nowIso } },
          { session: ctx.session, projection: { id: 1, org_id: 1, product: 1 } },
        )
        .toArray();
      return docs.map((d) => ({
        id: uuidOf(d.id),
        orgId: d.org_id,
        product: d.product,
      }));
    });
  }
}
