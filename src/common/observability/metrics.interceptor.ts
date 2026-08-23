import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { httpRequestDuration, httpRequestsTotal } from './metrics';

/**
 * Global HTTP instrumentation: every response feeds the request counter and
 * latency histogram. Route labels use the ROUTER path template (param ids
 * never become label values — cardinality stays bounded), normalized to a
 * fixed unknown-route label when Fastify has not resolved one (404s,
 * pre-routing errors).
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isHttp = context.getType<'http'>() === 'http';
    if (!isHttp) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest & { routeOptions?: { url?: string } }>();
    const response = http.getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();

    const finish = (): void => {
      const route = normalizeRoute(request.routeOptions?.url ?? request.url);
      const method = request.method.toUpperCase();
      const status = String(response.statusCode);
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      httpRequestsTotal.inc({ route, method, status });
      httpRequestDuration.observe({ route, method }, seconds);
    };

    return next.handle().pipe(
      tap({
        next: () => finish(),
        error: () => finish(), // the exception filter owns the status; timing still counts
      }),
    );
  }
}

const CARDINALITY_CEILING = 4; // path segments kept for unknown routes

function normalizeRoute(rawUrl: string): string {
  const path = rawUrl.split('?')[0];
  // Router templates already contain :params — label-safe. Raw urls (no
  // router match) are collapsed to their first segments to bound cardinality.
  if (path.includes(':')) {
    return path;
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  return `/${segments.slice(0, CARDINALITY_CEILING).join('/')}${segments.length > CARDINALITY_CEILING ? '/…' : ''}`;
}
