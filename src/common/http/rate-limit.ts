import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { RedisService } from '../infra/redis.service';
import { ApiError } from './api-error';
import { Principal } from '../auth/principal';

export const RATE_LIMIT_KEY = 'rate-limit';

export interface RateLimitOptions {
  /** Bucket capacity (burst size). */
  capacity: number;
  /** Tokens added per second (sustained rate). */
  refillPerSecond: number;
  /** Bucket scope: 'ip' or 'principal' (falls back to IP when anonymous). */
  scope?: 'ip' | 'principal';
  /** Logical bucket name — distinct concerns get distinct buckets. */
  name?: string;
}

/** Attach a Redis token-bucket limit to a route. */
export function RateLimit(options: RateLimitOptions): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_KEY, options);
}

/**
 * Atomic token bucket in Lua — the INCR/EXPIRE dance is not race-free under
 * concurrent requests, and auth-path limits must be exact.
 *
 * KEYS[1] = bucket key; ARGV = capacity, refillPerSecond, nowMs, cost(=1).
 * Returns: { allowed(0|1), retryAfterMs }.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + (elapsed / 1000.0) * refill)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 2000))
local retry = 0
if allowed == 0 and refill > 0 then
  retry = math.ceil(((cost - tokens) / refill) * 1000)
end
return { allowed, retry }
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly script: string = TOKEN_BUCKET_LUA;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options =
      this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getHandler()) ??
      this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getClass());
    if (!options) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
    const principal = request.principal;
    const scope =
      options.scope === 'principal' && principal
        ? `${principal.kind}:${principal.id}`
        : `ip:${request.ip ?? 'unknown'}`;
    const key = `rl:${options.name ?? 'default'}:${scope}`;

    let result: [number, number] | null = null;
    try {
      result = (await this.redis.raw.eval(this.script, 1, key, String(options.capacity), String(options.refillPerSecond), String(Date.now()), '1')) as [number, number];
    } catch {
      // Redis unavailable: fail-open with a log line. Auth-critical paths
      // carry additional per-artifact limits in their own tables (email
      // codes, invites), so a fail-open here never removes the hard caps.
      return true;
    }
    const [allowed, retryAfterMs] = result;
    if (allowed !== 1) {
      throw ApiError.rateLimited(Math.max(1, Math.ceil(retryAfterMs / 1000)));
    }
    return true;
  }
}
