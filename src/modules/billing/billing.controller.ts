import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { InvoicesService } from './invoices.service';
import { PlanChangeService } from './plan-change.service';
import { StripeService } from './stripe.service';
import { UsageQueryService } from './usage-query.service';

/**
 * Billing views for the portal's `/platform/billing` area (B-3): per-ledger
 * views + invoice records. Roles per the access-model: owner/admin/billing
 * (finance people manage money, not pipelines). Invoice state moves are
 * audited in the service; plan changes are purchase-adjacent money acts
 * (owner/billing + step-up), and Stripe Checkout sessions hang off unpaid
 * invoices.
 */
@Controller('console/billing')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class BillingController {
  constructor(
    private readonly usage: UsageQueryService,
    private readonly invoices: InvoicesService,
    private readonly plans: PlanChangeService,
    private readonly stripe: StripeService,
  ) {}

  /** Per-(org × product) ledgers with the entitlement-state join (M-3). */
  @Get(':orgId/ledgers')
  @Roles('owner', 'admin', 'billing')
  async ledgers(@Param('orgId') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.usage.ledgers(orgId, { from, to });
  }

  @Get(':orgId/invoices')
  @Roles('owner', 'admin', 'billing')
  async listInvoices(@Param('orgId') orgId: string, @Query('product') product?: string) {
    return { invoices: await this.invoices.list(orgId, product) };
  }

  @Get(':orgId/invoices/:invoiceId')
  @Roles('owner', 'admin', 'billing')
  async invoice(@Param('orgId') orgId: string, @Param('invoiceId') invoiceId: string) {
    return { invoice: await this.invoices.get(orgId, invoiceId) };
  }

  /** Draft the period invoice for one ledger (idempotent per period). */
  @Post(':orgId/invoices')
  @Roles('owner', 'billing')
  @Idempotent()
  @RateLimit({ name: 'billing-invoice-draft', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async createDraft(
    @Param('orgId') orgId: string,
    @Body() body: { product?: string; period_start?: string; period_end?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.product || !body.period_start || !body.period_end) {
      throw ApiError.validation({ input: 'product, period_start, period_end are required' });
    }
    const invoice = await this.invoices.createDraft({
      orgId,
      product: body.product,
      periodStart: body.period_start,
      periodEnd: body.period_end,
      actorId: principal.id,
    });
    return { invoice };
  }

  @Post(':orgId/invoices/:invoiceId/issue')
  @Roles('owner', 'billing')
  async issue(@Param('orgId') orgId: string, @Param('invoiceId') invoiceId: string, @CurrentPrincipal() principal: L1Principal) {
    return { invoice: await this.invoices.transition({ orgId, invoiceId, target: 'issued', actorId: principal.id }) };
  }

  @Post(':orgId/invoices/:invoiceId/pay')
  @Roles('owner', 'billing')
  async pay(@Param('orgId') orgId: string, @Param('invoiceId') invoiceId: string, @CurrentPrincipal() principal: L1Principal) {
    return { invoice: await this.invoices.transition({ orgId, invoiceId, target: 'paid', actorId: principal.id }) };
  }

  @Post(':orgId/invoices/:invoiceId/void')
  @Roles('owner', 'billing')
  async void(@Param('orgId') orgId: string, @Param('invoiceId') invoiceId: string, @CurrentPrincipal() principal: L1Principal) {
    return { invoice: await this.invoices.transition({ orgId, invoiceId, target: 'void', actorId: principal.id }) };
  }

  /**
   * Plan change / upgrade path (H-4): swap the entitlement's plan with
   * pro-rated proration recorded as a ledger adjustment. Purchase-adjacent:
   * owner/billing + step-up, like the studio trial start.
   */
  @Post(':orgId/plan')
  @Roles('owner', 'billing')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'billing-plan-change', capacity: 5, refillPerSecond: 0.01, scope: 'principal' })
  async changePlan(
    @Param('orgId') orgId: string,
    @Body() body: { product?: string; plan?: string },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (!body.product || !body.plan) {
      throw ApiError.validation({ input: 'product and plan are required' });
    }
    return this.plans.changePlan({ orgId, product: body.product, targetPlan: body.plan, actorId: principal.id });
  }

  /** Stripe Checkout session for an unpaid invoice (H-1); 503 when the rail is off. */
  @Post(':orgId/invoices/:invoiceId/checkout')
  @Roles('owner', 'billing')
  @RateLimit({ name: 'billing-checkout-session', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async checkout(
    @Param('orgId') orgId: string,
    @Param('invoiceId') invoiceId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const invoice = await this.invoices.get(orgId, invoiceId);
    if (invoice.status === 'paid' || invoice.status === 'void') {
      throw ApiError.conflict(`invoice is already ${invoice.status}`);
    }
    const session = await this.stripe.createCheckoutSession({
      invoiceId: invoice.id,
      orgId,
      product: invoice.product,
      description: `Neryva ${invoice.product} — ${invoice.periodStart.slice(0, 10)} to ${invoice.periodEnd.slice(0, 10)}`,
      totalUsd: invoice.totalUsd,
      currency: invoice.currency,
    });
    return { checkout_session: session };
  }
}
