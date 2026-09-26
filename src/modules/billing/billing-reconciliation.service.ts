import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { BillingWebhookInboxRow } from './usage-ledger.schema';
import type { IReconciliationRepository } from './repositories/reconciliation.repository';
import { RECONCILIATION_REPOSITORY } from './repositories/repository-tokens';

/**
 * Provider reconciliation (8.7) + billing webhook inbox (8.8).
 *
 * Reconciliation compares the internal ledger against itself and (when a
 * provider adapter is configured) provider statements: negative quantities
 * outside compensations, unbalanced reversals, and duplicate settled costs
 * become `discrepant` rows + a reconciliation run record — never silent
 * fixes. The webhook inbox drives inbound provider events through the
 * pinned state machine received -> signature_validated -> deduplicated ->
 * processed | rejected | reconciliation_required, keyed by
 * (provider, provider_event_id) for exactly-once handling.
 *
 * Persistence lives behind `IReconciliationRepository` (injected via
 * `RECONCILIATION_REPOSITORY`); this service holds only the business flow.
 */
@Injectable()
export class BillingReconciliationService {
  private static readonly logger = new Logger(BillingReconciliationService.name);

  constructor(
    @Inject(RECONCILIATION_REPOSITORY) private readonly recon: IReconciliationRepository,
  ) {}

  /**
   * One consistency pass for an org: flags ledger anomalies. Provider-side
   * comparison plugs in via a provider adapter when Stripe metering is
   * configured; the internal invariants run regardless (outage-deterministic).
   */
  async runConsistencyPass(input: { orgId: string; provider: string }): Promise<{ runId: string; checked: number; discrepancies: number; findings: string[] }> {
    const result = await this.recon.runConsistencyPass(input.orgId, input.provider);

    if (result.findings.length > 0) {
      BillingReconciliationService.logger.warn(`reconciliation run ${result.runId} found ${result.findings.length} discrepancies for org ${input.orgId}`);
    }
    return result;
  }

  // ── Billing webhook inbox (8.8) ─────────────────────────────────────────

  /**
   * Ingest a provider webhook. Signature verification happens BEFORE any
   * state transition (the controller verifies the HMAC; we record the
   * verdict). Duplicate (provider, provider_event_id) replays the recorded
   * outcome instead of re-processing — a provider payload can never grant
   * entitlement twice.
   */
  async ingestWebhook(input: {
    provider: string;
    providerEventId: string;
    payloadHash: string;
    signatureResult: 'valid' | 'invalid';
    payloadRef?: Record<string, unknown>;
  }): Promise<{ row: BillingWebhookInboxRow; duplicate: boolean }> {
    return this.recon.ingestWebhook({
      provider: input.provider,
      providerEventId: input.providerEventId,
      payloadHash: input.payloadHash,
      signatureResult: input.signatureResult,
      payloadRef: input.payloadRef,
    });
  }

  async markWebhookProcessed(id: string, processingResult: Record<string, unknown>): Promise<void> {
    await this.recon.markWebhookProcessed(id, processingResult);
  }

  async markWebhookRequiresReconciliation(id: string, reason: string): Promise<void> {
    await this.recon.markWebhookRequiresReconciliation(id, reason);
  }

  static payloadHash(rawBody: string): string {
    return createHash('sha256').update(rawBody).digest('hex');
  }
}
