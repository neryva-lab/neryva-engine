import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal, L3Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { PlatformStaffGuard, StaffRoles } from '../../common/policy/staff.guard';
import { SatelliteActivityService, satelliteKeyFor } from './satellite-activity.service';
import { RevocationLogService } from './revocation-log.service';

/**
 * The satellite revocation feed (connection contract part 2's missing
 * half): satellites poll `GET /internal/revocations?since=<cursor>` so the
 * runtime's caches converge on engine-side session/account/key kills.
 * Poll cadence is the satellite's choice (30–60s recommended); the cursor
 * protocol is resumable, so a restart never misses a revocation.
 */
@Controller('internal/revocations')
@AuthLayer('l3', 'l2')
@RequireScopes('engine:revocations')
export class RevocationsController {
  constructor(
    private readonly log: RevocationLogService,
    private readonly activity: SatelliteActivityService,
  ) {}

  @Get()
  @RateLimit({ name: 'revocations-poll', capacity: 120, refillPerSecond: 2, scope: 'principal' })
  async since(
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @CurrentPrincipal() principal?: L3Principal | L2Principal,
  ): Promise<unknown> {
    if (principal) {
      const key = satelliteKeyFor(principal);
      if (key) {
        this.activity.touch(key, 'revocations');
      }
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 200;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw ApiError.validation({ limit: 'positive integer required' });
    }
    try {
      return await this.log.since(since ?? '', parsedLimit);
    } catch (err) {
      if ((err as Error).message === 'malformed cursor') {
        throw ApiError.validation({ since: 'malformed cursor (expected <iso>|<uuid>)' });
      }
      throw err;
    }
  }

  /**
   * Ops/verification window view (staff, L2): rows in [from, to] — the
   * "what did we revoke during the incident" query the cursor feed cannot
   * answer backwards. Overrides the class scope (staff keys don't carry
   * engine:revocations) and pins to L2 only.
   */
  @Get('window')
  @AuthLayer('l2')
  @RequireScopes()
  @UseGuards(PlatformStaffGuard)
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  @RateLimit({ name: 'revocations-window', capacity: 30, refillPerSecond: 0.5, scope: 'principal' })
  async window(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ): Promise<{ revocations: unknown[] }> {
    const fromIso = from ?? new Date(Date.now() - 3_600_000).toISOString();
    const toIso = to ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(fromIso)) || !Number.isFinite(Date.parse(toIso))) {
      throw ApiError.validation({ from: 'from/to must be ISO timestamps' });
    }
    if (Date.parse(fromIso) > Date.parse(toIso)) {
      throw ApiError.validation({ from: 'from must precede to' });
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 200;
    return { revocations: await this.log.between(fromIso, toIso, Number.isFinite(parsedLimit) ? parsedLimit : 200) };
  }
}
