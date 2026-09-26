/**
 * `ICreditRepository` — the billing-credits aggregate (P3, the OpenAI
 * grants model).
 *
 * Promotional/trial/purchased balances applied against invoices
 * OLDEST-EXPIRING-FIRST at draft time; applications are recorded per
 * invoice so a voided invoice RETURNS its credit (reversible money).
 *
 * Each method owns one org-scoped transaction. The draft-time credit
 * application (`applyToInvoice`) does NOT live here — it moved into
 * `IInvoiceDraftRepository.draftPeriodInvoice`, which owns the draft
 * transaction it must run inside.
 *
 * What stays OUT: grant validation (amount bounds, kind), the draft-time
 * application algorithm, and audit writes (replayed by the service).
 */
import type { BillingCreditRow } from './repository-types';

export interface GrantCreditInput {
  orgId: string;
  /** Default 'grant'. */
  kind?: string;
  amountUsd: number;
  note?: string;
  expiresAt?: string | null;
  grantedBy: string;
}

export interface ICreditRepository {
  grantCredit(input: GrantCreditInput): Promise<BillingCreditRow>;

  /** Oldest-expiring-first (NULL expiry last — the draft-time ordering). */
  listCredits(orgId: string): Promise<BillingCreditRow[]>;

  /** Sum of remaining_usd over unexpired credits, formatted to 2dp. */
  balance(orgId: string): Promise<string>;

  /**
   * A voided invoice returns its credit to the grants: for each recorded
   * application, add the applied amount back and delete the application row.
   */
  returnCreditFromInvoice(orgId: string, invoiceId: string): Promise<void>;
}
