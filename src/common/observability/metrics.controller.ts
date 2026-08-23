import { Controller, Get } from '@nestjs/common';
import { AuthLayer } from '../auth/decorators';
import { RateLimit } from '../http/rate-limit';
import { metrics } from './metrics';

/**
 * The Prometheus exposition endpoint. Scrapers authenticate with an L2 API
 * key (deny-by-default holds — /metrics is never public); the response is
 * the registry's text document with the standard content type.
 */
@Controller('metrics')
@AuthLayer('l2')
@RateLimit({ name: 'metrics-scrape', capacity: 30, refillPerSecond: 1, scope: 'principal' })
export class MetricsController {
  @Get()
  expose(): string {
    return metrics.expose();
  }
}
