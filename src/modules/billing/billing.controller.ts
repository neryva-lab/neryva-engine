import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { InvoicesService } from './invoices.service';
import { UsageQueryService } from './usage-query.service';

/**
 * Billing views for the portal's `/platform/billing` area (B-3): per-ledger
 * views + invoice records. Roles per the access-model: owner/admin/billing
 * (finance people manage money, not pipelines). Invoice state moves are
 * audited in the service; purchases themselves (plan changes) live in the
 * entitlement plane, not here.
 */
@Controller('console/billing')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class BillingController {
  constructor(
    private readonly usage: UsageQueryService,
    private readonly invoices: InvoicesService,
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
}
