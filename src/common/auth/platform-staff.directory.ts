import { eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../infra/db/db.service';
import { RedisService } from '../infra/redis.service';
import type { PlatformStaffResolution } from './ports';
import { platformStaff } from './platform-staff.schema';

/** Cache TTL for directory resolutions — revocation/grant invalidate explicitly. */
const CACHE_TTL_SECONDS = 60;

/** Shared cache key (the staff module's admin service invalidates the same entry). */
export function platformStaffCacheKey(accountId: string): string {
  return `auth:staff:${accountId}`;
}

/**
 * The staff directory — kernel-level port implementation (auth_plan.md D1).
 * The platform_staff table is the AUTHORITY for the staff axis; the L1 JWT
 * `platform_role` claim is an optimization. Resolution is cached 60s in Redis
 * (positive AND negative) with explicit invalidation on every transition, so
 * a revoke takes effect on the next request while the hot path stays off the
 * database. The optional `expires_at` JIT lever is evaluated at read time — a
 * cached grant past its expiry resolves to null without waiting for the cache
 * to age out.
 *
 * Only db + redis live here (kernel-legal). Grant/revoke/list/bootstrap — the
 * surfaces that need accounts lookups and audit — are the staff module's
 * PlatformStaffAdminService.
 */
@Injectable()
export class PlatformStaffDirectoryService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  async resolve(accountId: string): Promise<PlatformStaffResolution> {
    const key = platformStaffCacheKey(accountId);
    try {
      const cached = await this.redis.raw.get(key);
      if (typeof cached === 'string' && cached.length > 0) {
        try {
          return withinExpiry(JSON.parse(cached) as PlatformStaffResolution);
        } catch {
          // corrupt cache entry — fall through to the authority
        }
      }
    } catch {
      // cache down — the authority read below is the correctness path
    }
    const rows = await this.db.root.select().from(platformStaff).where(eq(platformStaff.accountId, accountId)).limit(1);
    const row = rows[0];
    const resolution: PlatformStaffResolution =
      row && !row.revokedAt ? { role: row.role as NonNullable<PlatformStaffResolution['role']>, expiresAt: row.expiresAt } : { role: null, expiresAt: null };
    await this.redis.raw.setex(key, CACHE_TTL_SECONDS, JSON.stringify(resolution)).catch(() => undefined);
    return withinExpiry(resolution);
  }
}

function withinExpiry(resolution: PlatformStaffResolution): PlatformStaffResolution {
  if (resolution.role && resolution.expiresAt && Date.parse(resolution.expiresAt) <= Date.now()) {
    return { role: null, expiresAt: null };
  }
  return resolution;
}
