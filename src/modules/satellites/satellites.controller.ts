import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal, L3Principal } from '../../common/auth/principal';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { SatelliteRegistryService } from './satellite-registry.service';

/**
 * The satellite operations plane (/internal/satellites — auth map row 19):
 * heartbeats arrive on L3 service tokens; the status view is the staff
 * overlay (L2). Placeholder satellites are refused here, not at the network
 * edge, so the audit trail records the attempt.
 */
@Controller('internal/satellites')
export class SatellitesController {
  constructor(private readonly registry: SatelliteRegistryService) {}

  /**
   * Heartbeat (connection contract part 1 evidence). The satellite's own
   * service identity authorizes it: a service token may only beat its own
   * row (svc-agent-runtime → agent-runtime).
   */
  @Post(':key/heartbeat')
  @AuthLayer('l3')
  @RequireScopes('engine:heartbeat')
  @RateLimit({ name: 'satellite-heartbeat', capacity: 30, refillPerSecond: 0.5, scope: 'principal' })
  async heartbeat(
    @Param('key') key: string,
    @CurrentPrincipal() principal: L3Principal,
    @Body() body: { version?: string; metadata?: Record<string, unknown> },
  ): Promise<{ ok: true; interval_seconds: number }> {
    const expectedKey = principal.id.replace(/^svc-/, '');
    if (key !== expectedKey && principal.id !== key) {
      throw ApiError.forbidden('A service token may only heartbeat its own satellite row');
    }
    try {
      return await this.registry.heartbeat({ key, version: body.version, metadata: body.metadata });
    } catch (err) {
      throw ApiError.forbidden((err as Error).message);
    }
  }

  /** Operational status with liveness (staff overlay, L2). */
  @Get()
  @AuthLayer('l2')
  async status(): Promise<{ satellites: unknown[] }> {
    return { satellites: await this.registry.statusView() };
  }

  /** One satellite's detail (staff overlay, L2). */
  @Get(':key')
  @AuthLayer('l2')
  async detail(@Param('key') key: string): Promise<{ satellite: unknown | null }> {
    return { satellite: await this.registry.get(key) };
  }
}
