import { Controller, Get, Headers } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { RateLimit } from '../../common/http/rate-limit';
import { ConsoleHomeService } from './console-home.service';

/**
 * The console home API (C-3): the one endpoint the web app's /platform
 * page renders from. L1-only surface; org context comes from the
 * X-Neryva-Org header (the picker) or defaults to the first membership.
 */
@Controller('console')
@AuthLayer('l1')
@RateLimit({ name: 'console-home', capacity: 60, refillPerSecond: 1, scope: 'principal' })
export class ConsoleHomeController {
  constructor(private readonly homeService: ConsoleHomeService) {}

  @Get('home')
  async home(
    @CurrentPrincipal() principal: L1Principal,
    @Headers('x-neryva-org') orgHeader?: string | string[],
  ): Promise<unknown> {
    const requested = Array.isArray(orgHeader) ? orgHeader[0] : orgHeader;
    return this.homeService.home(principal, requested ?? null);
  }
}
