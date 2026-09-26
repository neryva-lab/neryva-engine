/**
 * `IAdjustmentRepository` — the adjustments aggregate (P3, B-7).
 *
 * Manual credit/debit notes on a ledger with a reason — the correction
 * path for bad events short of voiding an invoice. Signed amount
 * (negative = credit). `appliedInvoiceId` is set when consumed by a draft;
 * NULL = pending.
 *
 * Each method owns one org-scoped transaction. The draft-time consumption
 * (`applyAdjustments`) does NOT live here — it moved into
 * `IInvoiceDraftRepository.draftPeriodInvoice`, which owns the draft
 * transaction it must run inside.
 *
 * What stays OUT: kind/sign validation and audit writes (the service).
 */
import type { BillingAdjustmentRow } from './repository-types';

export interface CreateAdjustmentInput {
  orgId: string;
  product: string;
  kind: string;
  amountUsd: number;
  reason: string;
  createdBy: string;
}

export interface IAdjustmentRepository {
  createAdjustment(input: CreateAdjustmentInput): Promise<BillingAdjustmentRow>;

  listAdjustments(orgId: string, product?: string): Promise<BillingAdjustmentRow[]>;
}
