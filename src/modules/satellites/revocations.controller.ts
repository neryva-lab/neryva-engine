import { Controller, Get, Query } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal, L3Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
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
}
