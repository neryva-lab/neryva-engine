import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { billingAdjustments } from '../billing-extension.schema';
import type { BillingAdjustmentRow } from './repository-types';
import type {
  CreateAdjustmentInput,
  IAdjustmentRepository,
} from './adjustment.repository';

/**
 * PostgreSQL `IAdjustmentRepository` (P3, B-7). Mechanical extraction of
 * the adjustment persistence from `BillingCreditsService.createAdjustment`
 * and `BillingExtensionController.listAdjustments`.
 *
 * Kind/sign validation and audit stay in the service; the draft-time
 * consumption (`applyAdjustments`) lives in
 * `IInvoiceDraftRepository.draftPeriodInvoice`.
 */
@Injectable()
export class PgAdjustmentRepository implements IAdjustmentRepository {
  constructor(private readonly db: DbService) {}

  async createAdjustment(input: CreateAdjustmentInput): Promise<BillingAdjustmentRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingAdjustments)
        .values({
          orgId: input.orgId,
          product: input.product,
          kind: input.kind,
          amountUsd: input.amountUsd.toFixed(6),
          reason: input.reason.slice(0, 1024),
          createdBy: input.createdBy,
        })
        .returning(),
    );
    return inserted[0];
  }

  async listAdjustments(orgId: string, product?: string): Promise<BillingAdjustmentRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(billingAdjustments)
        .where(product ? and(eq(billingAdjustments.orgId, orgId), eq(billingAdjustments.product, product)) : eq(billingAdjustments.orgId, orgId)),
    );
  }
}
