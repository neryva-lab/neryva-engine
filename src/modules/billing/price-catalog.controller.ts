import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal, L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { PlatformStaffGuard, StaffRoles } from '../../common/policy/staff.guard';
import { PriceCatalogService } from './price-catalog.service';

/**
 * Price catalog management (staff-only): the platform's billing truth.
 * Versioned inserts only — prices never mutate retroactively.
 */
@Controller('internal/billing/price-catalog')
@AuthLayer('l2', 'l1')
@UseGuards(PlatformStaffGuard)
@StaffRoles('super_admin', 'tenant_admin')
export class PriceCatalogController {
  constructor(private readonly prices: PriceCatalogService) {}

  @Get()
  @RateLimit({ name: 'price-catalog-list', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async list(@Query('product') product?: string) {
    return { catalog: await this.prices.list(product), validation_posture: this.prices.posture() };
  }

  @Post()
  @RateLimit({ name: 'price-catalog-add', capacity: 20, refillPerSecond: 0.1, scope: 'principal' })
  async addVersion(
    @CurrentPrincipal() principal: L1Principal | L2Principal,
    @Body()
    body: {
      product?: string;
      kind?: string;
      model?: string | null;
      price_per_million_input_usd?: number;
      price_per_million_output_usd?: number;
      price_per_event_usd?: number;
      effective_from?: string;
      note?: string;
    },
  ) {
    if (!body.product || !body.kind || !body.effective_from) {
      throw ApiError.validation({ input: 'product, kind, effective_from are required' });
    }
    const row = await this.prices.addVersion({
      product: body.product,
      kind: body.kind,
      model: body.model ?? null,
      pricePerMillionInputUsd: body.price_per_million_input_usd ?? null,
      pricePerMillionOutputUsd: body.price_per_million_output_usd ?? null,
      pricePerEventUsd: body.price_per_event_usd ?? null,
      effectiveFrom: body.effective_from,
      note: body.note,
      actorId: principal.id,
    });
    return { price: row };
  }
}
