/**
 * MongoDB lane for {@link ICreditRepository} (P3, the OpenAI grants
 * model). Mirrors `PgCreditRepository` method-for-method: grants store
 * money as 6dp strings; listing is oldest-expiring-first (NULL expiry
 * last — pg's `asc` default NULLS LAST); the balance sums unexpired
 * remaining balances formatted to 2dp; a voided invoice returns its
 * credit per recorded application (reversible money).
 *
 * Draft-time application lives in `IInvoiceDraftRepository` — this port
 * never applies credit outside a draft.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { BillingCreditRow } from './repository-types';
import {
  binUuid,
  requireOrg,
  tenantCollection,
  toCredit,
  toFixed6,
  type BillingCreditApplicationMongoDoc,
  type BillingCreditMongoDoc,
} from './mongo-documents';
import type { GrantCreditInput, ICreditRepository } from './credit.repository';

const CREDITS = 'billing_credits';
const APPLICATIONS = 'billing_credit_applications';

@Injectable()
export class MongoCreditRepository implements ICreditRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async grantCredit(input: GrantCreditInput): Promise<BillingCreditRow> {
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingCreditMongoDoc>(this.mongo.root, CREDITS, 'org_id');
      const now = new Date().toISOString();
      const doc: BillingCreditMongoDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(org),
        kind: input.kind ?? 'grant',
        note: input.note?.slice(0, 256) ?? null,
        amount_usd: toFixed6(input.amountUsd),
        remaining_usd: toFixed6(input.amountUsd),
        granted_by: input.grantedBy,
        expires_at: input.expiresAt ?? null,
        created_at: now,
      };
      await col.insertOne(org, doc, { session: ctx.session });
      return toCredit(doc);
    });
  }

  async listCredits(orgId: string): Promise<BillingCreditRow[]> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingCreditMongoDoc>(this.mongo.root, CREDITS, 'org_id');
      // pg `orderBy(asc(expiresAt))` — ascending, NULLS LAST.
      const docs = (await col
        .aggregate(
          org,
          [
            { $addFields: { expires_rank: { $cond: [{ $eq: ['$expires_at', null] }, 1, 0] } } },
            { $sort: { expires_rank: 1, expires_at: 1 } },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as (BillingCreditMongoDoc & { expires_rank: number })[];
      return docs.map(toCredit);
    });
  }

  async balance(orgId: string): Promise<string> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const col = tenantCollection<BillingCreditMongoDoc>(this.mongo.root, CREDITS, 'org_id');
      const now = new Date().toISOString();
      const rows = (await col
        .aggregate(
          org,
          [
            { $match: { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] } },
            { $group: { _id: null, total: { $sum: { $toDouble: '$remaining_usd' } } } },
          ],
          { session: ctx.session },
        )
        .toArray()) as unknown as ({ _id: null; total: number })[];
      return (rows[0]?.total ?? 0).toFixed(2);
    });
  }

  /** A voided invoice returns its credit to the grants (reversible money). */
  async returnCreditFromInvoice(orgId: string, invoiceId: string): Promise<void> {
    await this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const session = { session: ctx.session };
      const applications = tenantCollection<BillingCreditApplicationMongoDoc>(this.mongo.root, APPLICATIONS, 'org_id');
      const credits = tenantCollection<BillingCreditMongoDoc>(this.mongo.root, CREDITS, 'org_id');
      const apps = await applications
        .find(org, { invoice_id: binUuid(invoiceId, 'invoiceId') }, session)
        .toArray();
      for (const app of apps) {
        const credit = await credits.findOne(org, { id: app.credit_id }, session);
        if (!credit) {
          continue;
        }
        const next = Number(credit.remaining_usd) + Number(app.applied_usd);
        await credits.updateOne(org, { id: credit.id }, { $set: { remaining_usd: toFixed6(next) } }, session);
        await applications.deleteOne(org, { id: app.id }, session);
      }
    });
  }
}
