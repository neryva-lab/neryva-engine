import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { env } from '../../common/config/env';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { billingInvoices } from './schema';

/**
 * The minimal Stripe payment rail (H-1). No SDK dependency: Checkout
 * Sessions are created against the Stripe REST API with fetch
 * (form-encoded body), and webhook signatures are verified by hand with
 * node:crypto following Stripe's scheme exactly:
 *
 *   signed_payload = "{timestamp}.{raw_body}"
 *   expected       = HMAC_SHA256(webhook_secret, signed_payload)
 *   header         = "t={timestamp},v1={hex}..."
 *
 * with a ±5-minute tolerance and a constant-time compare. The whole rail
 * is gated behind STRIPE_ENABLED + a secret key; disabled it is a 503 at
 * the surface (the degrade-loudly rule) and contributes nothing else.
 *
 * Settlement is idempotent: `checkout.session.completed` carries the
 * invoice id in metadata/client_reference_id; the UPDATE only matches a
 * draft/issued row, so an already-paid invoice (i.e. Stripe's retries) is
 * a no-op. Every recorded payment is audited on the hash-chained trail
 * and emits `billing.invoice_paid`.
 */
const WEBHOOK_TOLERANCE_SECONDS = 300;
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

@Injectable()
export class StripeService {
  private static readonly logger = new Logger(StripeService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /** The rail is live only when explicitly enabled AND keyed. */
  get enabled(): boolean {
    return env.STRIPE_ENABLED && env.STRIPE_SECRET_KEY.length > 0;
  }

  /**
   * Create a Checkout Session for one unpaid invoice. Draft invoices are
   * issued implicitly (a customer cannot pay a draft); void/paid invoices
   * are rejected.
   */
  async createCheckoutSession(input: {
    invoiceId: string;
    orgId: string;
    product: string;
    description: string;
    totalUsd: string;
    currency: string;
  }): Promise<StripeCheckoutSession> {
    if (!this.enabled) {
      throw ApiError.unavailable('stripe');
    }
    const successUrl = env.STRIPE_CHECKOUT_SUCCESS_URL || `${env.ENGINE_BASE_URL.replace(/\/$/, '')}/console/billing`;
    const cancelUrl = env.STRIPE_CHECKOUT_CANCEL_URL || successUrl;
    const unitAmount = Math.round(Number(input.totalUsd) * 100);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
      throw ApiError.validation({ total_usd: 'invoice total must be a positive amount' });
    }

    // Stripe Checkout takes form-encoded bodies (no JSON on this endpoint).
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: input.invoiceId,
      'metadata[invoice_id]': input.invoiceId,
      'metadata[org_id]': input.orgId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': input.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(unitAmount),
      'line_items[0][price_data][product_data][name]': input.description.slice(0, 200),
    });
    const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      StripeService.logger.error(`stripe checkout session failed (${response.status}): ${JSON.stringify(payload).slice(0, 512)}`);
      throw ApiError.unavailable('stripe');
    }
    return { id: String(payload.id ?? ''), url: String(payload.url ?? '') };
  }

  /**
   * Verify a Stripe-Signature header against the RAW request body. Returns
   * the parsed event or null (any verification failure is a silent null —
   * the controller answers 400 uniformly).
   */
  verifyEvent(rawBody: string, signatureHeader: string | undefined): StripeEvent | null {
    if (!env.STRIPE_WEBHOOK_SECRET || !signatureHeader) {
      return null;
    }
    const parts = new Map<string, string>();
    for (const piece of signatureHeader.split(',')) {
      const [key, value] = piece.split('=', 2);
      if (key && value) {
        parts.set(key.trim(), value.trim());
      }
    }
    const timestamp = parts.get('t') ?? '';
    const provided = parts.get('v1') ?? '';
    if (!timestamp || !provided) {
      return null;
    }
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number.parseInt(timestamp, 10));
    if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
      return null;
    }
    const expected = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }
    try {
      const event = JSON.parse(rawBody) as StripeEvent;
      if (!event || typeof event.type !== 'string' || !event.data?.object) {
        return null;
      }
      return event;
    } catch {
      return null;
    }
  }

  /**
   * Settle one event: mark its invoice paid per the state machine
   * (draft/issued → paid; issued_at backfilled for implicit issuance).
   * Other event types are accepted-and-ignored (Stripe requires a fast
   * 200 for everything). Returns whether this call did the transition.
   */
  async handleEvent(event: StripeEvent): Promise<{ handled: boolean; invoiceId: string | null }> {
    if (event.type !== 'checkout.session.completed' && event.type !== 'invoice.paid') {
      return { handled: false, invoiceId: null };
    }
    const object = event.data.object as {
      id?: string;
      client_reference_id?: string | null;
      metadata?: Record<string, string> | null;
    };
    const invoiceId = object.metadata?.invoice_id ?? object.client_reference_id ?? null;
    if (!invoiceId) {
      StripeService.logger.warn(`stripe event ${event.id} (${event.type}) carried no invoice reference`);
      return { handled: false, invoiceId: null };
    }

    const now = new Date().toISOString();
    const updated = await this.db.withBypass((tx) =>
      tx
        .update(billingInvoices)
        .set({
          status: 'paid',
          issuedAt: sql`coalesce(${billingInvoices.issuedAt}, ${now}::timestamptz)`,
          paidAt: now,
          updatedAt: now,
        })
        .where(and(eq(billingInvoices.id, invoiceId), inArray(billingInvoices.status, ['draft', 'issued'])))
        .returning(),
    );
    const invoice = updated[0];
    if (!invoice) {
      // Already paid (retry) or unknown id — both are non-transitions.
      return { handled: false, invoiceId };
    }

    await this.audit.add({
      action: 'billing.payment_recorded',
      resourceType: 'billing_invoice',
      resourceId: invoice.id,
      actorType: 'system',
      tenantId: invoice.orgId,
      productTag: invoice.product,
      details: {
        provider: 'stripe',
        stripe_event_id: event.id,
        stripe_object_id: object.id ?? '',
        total_usd: invoice.totalUsd,
        method: 'checkout_session',
      },
    });
    await this.events.emit(EngineEvents.BillingInvoicePaid, {
      orgId: invoice.orgId,
      invoiceId: invoice.id,
      product: invoice.product,
      provider: 'stripe',
    });
    return { handled: true, invoiceId: invoice.id };
  }
}
