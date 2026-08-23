import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';
import { map, catchError, mergeMap } from 'rxjs/operators';
import { createHash } from 'node:crypto';
import { RedisService } from '../infra/redis.service';
import { ApiError } from './api-error';
import { Principal } from '../auth/principal';

export const IDEMPOTENT_KEY = 'idempotent';
export interface IdempotencyOptions {
  /** TTL for stored responses (ms). Default 24h. */
  ttlMs?: number;
}
const IDEMPOTENCY_HEADER = 'idempotency-key';
const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replay';

/**
 * Idempotency on mutating public routes (modularity §4): every decorated
 * POST accepts an Idempotency-Key. Scope = principal + key; the request
 * fingerprint (method+path+body hash) guards against key reuse with a
 * different payload; replays return the stored response verbatim.
 */
export function Idempotent(options: IdempotencyOptions = {}): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, { ttlMs: options.ttlMs ?? 24 * 60 * 60 * 1000 }),
    UseInterceptors(IdempotencyInterceptor),
  );
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest & { principal?: Principal }>();
    const response = http.getResponse<FastifyReply>();

    const headerValue = request.headers[IDEMPOTENCY_HEADER];
    const idempotencyKey = (Array.isArray(headerValue) ? headerValue[0] : headerValue)?.trim();
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return next.handle();
    }

    const ttlMs: number =
      (context.getHandler() as unknown as Record<string, IdempotencyOptions | undefined>)[IDEMPOTENT_KEY]?.ttlMs ?? 24 * 60 * 60 * 1000;
    const principal = request.principal;
    const principalScope = principal ? `${principal.kind}:${principal.id}` : `anon:${request.ip ?? 'unknown'}`;
    const fingerprint = createHash('sha256')
      .update(`${request.method}\n${request.url}\n${typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {})}`)
      .digest('hex');
    const redisKey = `idem:${principalScope}:${idempotencyKey}`;

    const existing = await this.redis.raw.get(redisKey);
    if (existing) {
      const stored = JSON.parse(existing) as { fingerprint: string; status: number; body: unknown; in_flight?: boolean };
      if (stored.in_flight) {
        throw new ApiError(409, 'idempotency_in_flight', 'A request with this Idempotency-Key is currently in flight');
      }
      if (stored.fingerprint !== fingerprint) {
        throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body');
      }
      response.status(stored.status);
      response.header(IDEMPOTENT_REPLAY_HEADER, 'true');
      // Resolve synchronously with the stored body.
      return new Observable<unknown>((subscriber) => {
        subscriber.next(stored.body);
        subscriber.complete();
      });
    }

    // Mark in-flight (10-minute lease covers normal handler durations).
    const claimed = await this.redis.raw.set(redisKey, JSON.stringify({ fingerprint, in_flight: true }), 'EX', 600, 'NX');
    if (!claimed) {
      throw new ApiError(409, 'idempotency_in_flight', 'A request with this Idempotency-Key is currently in flight');
    }

    let statusCode = response.statusCode;
    return next.handle().pipe(
      tap(() => {
        statusCode = response.statusCode;
      }),
      map((body) => ({ captured: true, body, statusCode: response.statusCode })),
      mergeMap(async ({ body, statusCode: capturedStatus }) => {
        await this.redis.raw.set(redisKey, JSON.stringify({ fingerprint, status: capturedStatus, body }), 'PX', ttlMs);
        return body;
      }),
      catchError(async (err: unknown) => {
        // Failures are not cached — the client may safely retry the same key.
        await this.redis.raw.del(redisKey);
        throw err;
      }),
    );
  }
}
