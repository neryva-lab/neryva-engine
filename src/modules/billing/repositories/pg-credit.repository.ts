import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import {
  billingCreditApplications,
  billingCredits,
} from '../billing-extension.schema';
import type { BillingCreditRow } from './repository-types';
import type {
  GrantCreditInput,
  ICreditRepository,
} from './credit.repository';

/**
 * PostgreSQL `ICreditRepository` (P3). Mechanical extraction of the
 * non-transactional credit methods from `BillingCreditsService`
 * (`grantCredit`, `listCredits`, `balance`, `returnCreditFromInvoice`).
 *
 * Validation (amount bounds, kind) and audit stay in the service; the
 * draft-time application (`applyToInvoice`) lives in
 * `IInvoiceDraftRepository.draftPeriodInvoice`.
 */
@Injectable()
export class PgCreditRepository implements ICreditRepository {
  constructor(private readonly db: DbService) {}

  async grantCredit(input: GrantCreditInput): Promise<BillingCreditRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(billingCredits)
        .values({
          orgId: input.orgId,
          kind: input.kind ?? 'grant',
          note: input.note?.slice(0, 256) ?? null,
          amountUsd: input.amountUsd.toFixed(6),
          remainingUsd: input.amountUsd.toFixed(6),
          expiresAt: input.expiresAt ?? null,
          grantedBy: input.grantedBy,
        })
        .returning(),
    );
    return inserted[0];
  }

  async listCredits(orgId: string): Promise<BillingCreditRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(billingCredits).where(eq(billingCredits.orgId, orgId)).orderBy(asc(billingCredits.expiresAt)),
    );
  }

  async balance(orgId: string): Promise<string> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${billingCredits.remainingUsd}), 0)` })
        .from(billingCredits)
        .where(and(eq(billingCredits.orgId, orgId), or(isNull(billingCredits.expiresAt), gt(billingCredits.expiresAt, new Date().toISOString())))),
    );
    return Number(rows[0]?.total ?? 0).toFixed(2);
  }

  /** A voided invoice returns its credit to the grants (reversible money). */
  async returnCreditFromInvoice(orgId: string, invoiceId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      const applications = await tx.select().from(billingCreditApplications).where(eq(billingCreditApplications.invoiceId, invoiceId));
      for (const application of applications) {
        await tx
          .update(billingCredits)
          .set({ remainingUsd: sql`${billingCredits.remainingUsd} + ${application.appliedUsd}` })
          .where(eq(billingCredits.id, application.creditId));
        await tx.delete(billingCreditApplications).where(eq(billingCreditApplications.id, application.id));
      }
    });
  }
}
