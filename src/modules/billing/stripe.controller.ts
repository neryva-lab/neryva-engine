import { Controller, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ApiError } from '../../common/http/api-error';
import { Public } from '../../common/auth/decorators';
import { StripeService } from './stripe.service';

/**
 * The Stripe webhook receiver (H-1). Deliberately @Public: authentication
 * IS the HMAC signature over the raw body — anything less would be theater.
 * Fastify's JSON parser stashes the untouched payload on `request.rawBody`
 * (see the content-type parser in main.ts) so verification sees the exact
 * bytes Stripe signed. Every event gets a fast 200; a bad signature is a
 * uniform 400 with no detail.
 */
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly stripe: StripeService) {}

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
    await this.stripe.handleEvent(event);
    return { received: true };
  }
}
