import { Controller, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../../common/http/api-error';
import { Public } from '../../common/auth/decorators';
import { StripeService } from './stripe.service';
import { BillingReconciliationService } from './billing-reconciliation.service';

/**
 * The Stripe webhook receiver (H-1). Deliberately @Public: authentication
 * IS the HMAC signature over the raw body — anything less would be theater.
 * Fastify's JSON parser stashes the untouched payload on  * (see the content-type parser in main.ts) so verification sees the exact
 * bytes Stripe signed. Every event gets a fast 200; a bad signature is a
 * uniform 400 with no detail.
 *
 * Phase 8.8: every event passes through the billing webhook inbox —
 * (provider, provider_event_id) dedup happens BEFORE handleEvent, so a
 * replayed or racing delivery cannot double-apply entitlement or billing
 * changes, and processing failures land in reconciliation_required
 * instead of being silently dropped.
 */
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    private readonly stripe: StripeService,
    private readonly inbox: BillingReconciliationService,
  ) {}

  @Post()
  @Public()
  async receive(@Req() request: FastifyRequest & { rawBody?: string }): Promise<{ received: boolean }> {
    if (!this.stripe.enabled) {
      throw ApiError.unavailable('stripe');
    }
    const rawBody = request.rawBody ?? (typeof request.body === 'string' ? request.body : '');
    const signatureHeader = request.headers['stripe-signature'];
    const event = this.stripe.verifyEvent(rawBody, Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader);
    if (!event) {
      throw ApiError.validation({ signature: 'invalid' });
    }

    const claim = await this.inbox.ingestWebhook({
      provider: 'stripe',
      providerEventId: String(event.id ?? ''),
      payloadHash: BillingReconciliationService.payloadHash(rawBody),
      signatureResult: 'valid',
      payloadRef: { type: event.type ?? null },
    });
    if (claim.duplicate) {
      return { received: true }; // replay: recorded outcome governs, no reprocessing
    }

    try {
      const result = await this.stripe.handleEvent(event);
      await this.inbox.markWebhookProcessed(claim.row.id, { handled: result.handled, invoice_id: result.invoiceId });
    } catch (err) {
      // Provider payloads never fail silently: unhandled processing lands in
      // reconciliation, and the ops runbook owns the disposition.
      await this.inbox.markWebhookRequiresReconciliation(claim.row.id, (err as Error).message.slice(0, 512));
    }
    return { received: true };
  }
}
