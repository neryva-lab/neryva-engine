import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../../common/infra/redis.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { env } from '../../common/config/env';
import { ACCOUNT_REPOSITORY, SESSION_REPOSITORY, OAUTH_CLIENT_REPOSITORY } from './repositories/repository-tokens';
import type { IAccountRepository } from './repositories/account.repository';
import type { ISessionRepository } from './repositories/session.repository';
import type { IOauthClientRepository } from './repositories/client.repository';

/**
 * Identity's implementations of the kernel ports (the dependency-inversion
 * seam: kernel defines, identity binds). These are the ONLY places the
 * kernel's guards touch identity tables.
 *
 * Persistence goes through the provider-blind repository ports
 * (`ISessionRepository`, `IAccountRepository`, `IOauthClientRepository`).
 */
@Injectable()
export class IdentityPublicService implements SessionRegistryLike, ServiceClientLike {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accountsRepo: IAccountRepository,
    @Inject(OAUTH_CLIENT_REPOSITORY) private readonly clients: IOauthClientRepository,
    private readonly redis: RedisService,
    private readonly events: EventBus,
  ) {}

  /** SESSION_REGISTRY_PORT — the correctness fallback behind the Redis deny-list. */
  async isSessionActive(input: { accountId: string; sid: string | null; issuedAt: number }): Promise<boolean> {
    if (input.sid) {
      // P7 D-2: the JWT `sid` claim carries the OIDC session.uid (see the
      // provider's formats.customizers.jwt). Match session_uid first; fall
      // back to the legacy storage-id column for rows that predate it.
      const row = await this.sessions.findBySidOrUid(input.sid);
      if (!row || row.revokedAt || row.accountId !== input.accountId) {
        return false;
      }
    }
    // Account-level kill-switch: sessions minted before sessionsRevokedAt die.
    // A locked/disabled account holds NO live session — the status is read
    // on the same row so an abuse lock takes effect on the next request
    // (bounded by the access-token TTL only for the deny-list-miss path,
    // never beyond it: this registry check runs on every L1 request).
    const guard = await this.accountsRepo.sessionGuardState(input.accountId);
    if (!guard || guard.status !== 'active') {
      return false;
    }
    const revokedAt = guard.sessionsRevokedAt;
    if (!revokedAt) {
      return true;
    }
    const issuedMs = (input.issuedAt || 0) * 1000;
    return issuedMs > Date.parse(revokedAt);
  }

  /** SERVICE_CLIENT_PORT — DB-backed confirmation for L3 tokens. */
  async isActiveServiceClient(clientId: string): Promise<boolean> {
    return this.clients.isServiceClientActive(clientId);
  }

  /**
   * Push a deny-list key (TTL <= access TTL; correctness falls back above)
   * AND emit the revocation event — the satellites' durable feed records
   * OP-driven kills (logout / token revocation) through the same choke
   * point as user-driven ones.
   *
   * P7 D-2: `sid` here is the OIDC session.uid — the value the JWT `sid`
   * claim carries (provider formats.customizers.jwt) and the value the L1
   * guard looks up. Callers must resolve the session_uid first; pushing a
   * storage id or authz sid silently denies nothing.
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
