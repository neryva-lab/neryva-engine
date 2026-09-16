import { eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { RedisService } from '../../common/infra/redis.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { accounts, oauthClients, oauthSessions } from './schema';

/**
 * Identity's implementations of the kernel ports (the dependency-inversion
 * seam: kernel defines, identity binds). These are the ONLY places the
 * kernel's guards touch identity tables.
 */
@Injectable()
export class IdentityPublicService implements SessionRegistryLike, ServiceClientLike {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly events: EventBus,
  ) {}

  /** SESSION_REGISTRY_PORT — the correctness fallback behind the Redis deny-list. */
  async isSessionActive(input: { accountId: string; sid: string | null; issuedAt: number }): Promise<boolean> {
    if (input.sid) {
      const rows = await this.db.root.select().from(oauthSessions).where(eq(oauthSessions.sid, input.sid)).limit(1);
      const row = rows[0];
      if (!row || row.revokedAt || row.accountId !== input.accountId) {
        return false;
      }
    }
    // Account-level kill-switch: sessions minted before sessionsRevokedAt die.
    // A locked/disabled account holds NO live session — the status is read
    // on the same row so an abuse lock takes effect on the next request
    // (bounded by the access-token TTL only for the deny-list-miss path,
    // never beyond it: this registry check runs on every L1 request).
    const rows = await this.db.root
      .select({ status: accounts.status, sessionsRevokedAt: accounts.sessionsRevokedAt })
      .from(accounts)
      .where(eq(accounts.id, input.accountId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== 'active') {
      return false;
    }
    const revokedAt = row.sessionsRevokedAt;
    if (!revokedAt) {
      return true;
    }
    const issuedMs = (input.issuedAt || 0) * 1000;
    return issuedMs > Date.parse(revokedAt);
  }

  /** SERVICE_CLIENT_PORT — DB-backed confirmation for L3 tokens. */
  async isActiveServiceClient(clientId: string): Promise<boolean> {
    const rows = await this.db.root.select({ disabled: oauthClients.disabled, kind: oauthClients.kind }).from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    const row = rows[0];
    return !!row && !row.disabled && row.kind === 'service';
  }

  /**
   * Push a deny-list key (TTL <= access TTL; correctness falls back above)
   * AND emit the revocation event — the satellites' durable feed records
   * OP-driven kills (logout / token revocation) through the same choke
   * point as user-driven ones.
   */
  pushSidDeny(sid: string): void {
    void this.redis.raw.set(`auth:deny:sid:${sid}`, '1', 'EX', env.IDENTITY_ACCESS_TTL_SECONDS).catch(() => undefined);
    void this.events.emit(EngineEvents.SessionRevoked, { sid, accountId: '' }).catch(() => undefined);
  }
}

interface SessionRegistryLike {
  isSessionActive(input: { accountId: string; sid: string | null; issuedAt: number }): Promise<boolean>;
}

interface ServiceClientLike {
  isActiveServiceClient(clientId: string): Promise<boolean>;
}
