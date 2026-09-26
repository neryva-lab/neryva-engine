import { Body, Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { Idempotent } from '../../common/http/idempotency';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { BillingCreditsService } from './billing-credits.service';
import { ADJUSTMENT_REPOSITORY, INVOICE_LINE_REPOSITORY, SPEND_EVENT_REPOSITORY } from './repositories/repository-tokens';
import type { IAdjustmentRepository } from './repositories/adjustment.repository';
import type { IInvoiceLineRepository } from './repositories/invoice-line.repository';
import type { ISpendEventRepository } from './repositories/spend-event.repository';

/**
 * The billing extensions surface (gaps B-2/B-3/B-5/B-6/B-7): credits &
 * grants, budgets with threshold alerts, adjustments (credit/debit notes),
 * invoice line items, and the raw usage export. Money-mutating acts carry
 * the step-up proof (grants, adjustments); reads follow the money-role
 * matrix (owner/admin/billing).
 */
@Controller('console/billing')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class BillingExtensionController {
  constructor(
    private readonly credits: BillingCreditsService,
    private readonly manifests: ManifestRegistryService,
    @Inject(ADJUSTMENT_REPOSITORY) private readonly adjustments: IAdjustmentRepository,
    @Inject(INVOICE_LINE_REPOSITORY) private readonly invoiceLinesRepo: IInvoiceLineRepository,
    @Inject(SPEND_EVENT_REPOSITORY) private readonly spend: ISpendEventRepository,
  ) {}

  private orgId(header: string | string[] | undefined): string {
    const orgId = Array.isArray(header) ? header[0] : header;
    if (!orgId) {
      throw ApiError.validation({ org: 'X-Neryva-Org header required' });
    }
    return orgId;
  }

  // ── Credits (the grants model) ───────────────────────────────────────────

  @Get('org/:orgId/credits')
  @Roles('owner', 'admin', 'billing')
  async listCredits(@Param('orgId') orgId: string): Promise<{ credits: Array<Record<string, unknown>>; balance_usd: string }> {
    const [credits, balance] = await Promise.all([this.credits.listCredits(orgId), this.credits.balance(orgId)]);
    return { credits, balance_usd: balance };
  }

  @Post('org/:orgId/credits')
  @Roles('owner', 'billing')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'billing-credit-grant', capacity: 5, refillPerSecond: 0.01, scope: 'principal' })
  async grantCredit(
    @Param('orgId') orgId: string,
    @Body() body: { kind?: string; amount_usd?: number; note?: string; expires_at?: string | null },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ credit: Record<string, unknown> }> {
    if (typeof body.amount_usd !== 'number') {
      throw ApiError.validation({ amount_usd: 'number required' });
    }
    return { credit: await this.credits.grantCredit({ orgId, kind: body.kind, amountUsd: body.amount_usd, note: body.note, expiresAt: body.expires_at ?? null, grantedBy: principal.id }) };
  }

  // ── Budgets (B-3) ────────────────────────────────────────────────────────

  @Get('org/:orgId/budgets')
  @Roles('owner', 'admin', 'billing')
  async listBudgets(@Param('orgId') orgId: string): Promise<{ budgets: Array<Record<string, unknown>> }> {
    return { budgets: await this.credits.listBudgets(orgId) };
  }

  @Post('org/:orgId/budgets')
  @Roles('owner', 'admin', 'billing')
  @Idempotent()
  async createBudget(
    @Param('orgId') orgId: string,
    @Body() body: { product?: string | null; project_id?: string | null; monthly_usd?: number; thresholds?: number[] },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ budget: Record<string, unknown> }> {
    if (body.product) {
      this.manifests.require(body.product);
    }
    if (typeof body.monthly_usd !== 'number') {
      throw ApiError.validation({ monthly_usd: 'number required' });
    }
    return { budget: await this.credits.createBudget({ orgId, product: body.product ?? null, projectId: body.project_id ?? null, monthlyUsd: body.monthly_usd, thresholds: body.thresholds, createdBy: principal.id }) };
  }

  @Post('org/:orgId/budgets/:budgetId/delete')
  @Roles('owner', 'admin', 'billing')
  async deleteBudget(@Param('orgId') orgId: string, @Param('budgetId') budgetId: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.credits.deleteBudget(orgId, budgetId, principal.id);
    return { ok: true };
  }

  // ── Adjustments (B-7) ────────────────────────────────────────────────────

  @Get('org/:orgId/adjustments')
  @Roles('owner', 'admin', 'billing')
  async listAdjustments(@Param('orgId') orgId: string, @Query('product') product?: string): Promise<{ adjustments: Array<Record<string, unknown>> }> {
    const rows = await this.adjustments.listAdjustments(orgId, product);
    return {
      adjustments: rows.map((r) => ({
        id: r.id,
        product: r.product,
        kind: r.kind,
        amount_usd: r.amountUsd,
        reason: r.reason,
        applied_invoice_id: r.appliedInvoiceId,
        created_at: r.createdAt,
      })),
    };
  }

  @Post('org/:orgId/adjustments')
  @Roles('owner', 'billing')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @RateLimit({ name: 'billing-adjustment', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async createAdjustment(
    @Param('orgId') orgId: string,
    @Body() body: { product?: string; kind?: string; amount_usd?: number; reason?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ adjustment: Record<string, unknown> }> {
    if (!body.product || !body.kind || typeof body.amount_usd !== 'number' || !body.reason) {
      throw ApiError.validation({ input: 'product, kind, amount_usd, reason are required' });
    }
    this.manifests.require(body.product);
    return { adjustment: await this.credits.createAdjustment({ orgId, product: body.product, kind: body.kind, amountUsd: body.amount_usd, reason: body.reason, createdBy: principal.id }) };
  }

  // ── Invoice line items (B-5) ─────────────────────────────────────────────

  @Get('org/:orgId/invoices/:invoiceId/lines')
  @Roles('owner', 'admin', 'billing')
  async invoiceLines(@Param('orgId') orgId: string, @Param('invoiceId') invoiceId: string): Promise<{ lines: Array<Record<string, unknown>> }> {
    const rows = await this.invoiceLinesRepo.listLinesByInvoice(orgId, invoiceId);
    return {
      lines: rows.map((r) => ({
        kind: r.kind,
        model: r.model,
        events: r.events,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        amount_usd: r.amountUsd,
      })),
    };
  }

  // ── Usage export (B-6) ───────────────────────────────────────────────────

  @Get('org/:orgId/usage/export')
  @Roles('owner', 'admin', 'billing')
  @RateLimit({ name: 'billing-usage-export', capacity: 5, refillPerSecond: 0.02, scope: 'principal' })
  async usageExport(
    @Param('orgId') orgId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('product') product?: string,
  ): Promise<string> {
    const rows = await this.spend.exportUsage(orgId, { from: from ?? '', to: to ?? '', product });
    reply.header('content-type', 'application/x-ndjson');
    reply.header('content-disposition', `attachment; filename="neryva-usage-${orgId}.ndjson"`);
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }
}
