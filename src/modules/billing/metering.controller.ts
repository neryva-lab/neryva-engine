import { Body, Controller, Post } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal, L3Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { QuotaService, QuotaReservation } from './quota.service';
import { IngestResult, MAX_INGEST_BATCH, SpendIngestService } from './spend-ingest.service';

/**
 * The satellite ingest plane (B-1): `/internal/metering/**` — L3 service
 * tokens (the agent-runtime satellite) with the `engine:ingest` scope, or
 * L2 keys carrying it. This is the seam the A-3 metering handover plugs
 * into: the runtime flips its emitter to this endpoint during the
 * dual-write window and reconciliation compares both sides.
 */
@Controller('internal/metering')
@AuthLayer('l3', 'l2')
@RequireScopes('engine:ingest')
export class MeteringController {
  constructor(
    private readonly ingestService: SpendIngestService,
    private readonly quota: QuotaService,
  ) {}

  /**
   * Batch spend-event push. Idempotent per (source, event_id); per-row
   * rejections are reported without failing the batch (a poison row never
   * blocks the stream); a fully-invalid batch is a 400.
   */
  @Post('spend')
  @RateLimit({ name: 'metering-ingest', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async ingest(
    @CurrentPrincipal() principal: L3Principal | L2Principal,
    @Body() body: { events?: unknown[] },
  ): Promise<IngestResult> {
    const events = body.events;
    if (!Array.isArray(events)) {
      throw ApiError.validation({ events: 'events[] required' });
    }
    if (events.length > MAX_INGEST_BATCH) {
      throw ApiError.validation({ events: `batch exceeds the ${MAX_INGEST_BATCH}-event cap — split the push` });
    }
    return this.ingestService.ingest(principal.id, events);
  }

  /**
   * Quota reservation for the product/project levels (M-2): satellites ask
   * before a metered call; the decision is atomic across both buckets.
   */
  @Post('quota-check')
  @RateLimit({ name: 'metering-quota', capacity: 600, refillPerSecond: 50, scope: 'principal' })
  async quotaCheck(
    @CurrentPrincipal() _principal: L3Principal | L2Principal,
    @Body() body: { org_id?: string; product?: string; project_id?: string | null; estimated_cost_usd?: number; units?: number },
  ) {
    if (!body.org_id || !body.product) {
      throw ApiError.validation({ input: 'org_id and product are required' });
    }
    const reservation: QuotaReservation = {
      orgId: body.org_id,
      product: body.product,
      projectId: body.project_id ?? null,
      estimatedCostUsd: body.estimated_cost_usd,
      units: body.units,
    };
    return this.quota.checkAndReserve(reservation);
  }
}
