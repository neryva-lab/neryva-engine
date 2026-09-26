import { randomBytes } from 'node:crypto';
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { sha256Hex } from '../../common/infra/crypto/envelope';
import { SERVICE_ACCOUNT_REPOSITORY } from './repositories/repository-tokens';
import type { IServiceAccountRepository, ServiceAccountRow } from './repositories/service-account.repository';

export const SERVICE_ACCOUNT_TOKEN_PREFIX = 'nrv_sa_';

export interface ServiceAccountView {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'disabled';
  scopes: string[];
  hasToken: boolean;
  tokenPrefix: string | null;
  tokenExpiresAt: string | null;
  tokenLastUsedAt: string | null;
  tokenLastRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SCOPE_RE = /^[a-z0-9][a-z0-9:*_-]{0,63}$/;
const MAX_SCOPES = 32;

/**
 * Service accounts (eng-0009, OpenAI-platform pattern): org-owned machine
 * identities listed in the member inventory alongside humans. Each holds at
 * most ONE active token — `nrv_sa_` + 32 bytes base64url, sha256 at rest,
 * returned exactly once on create/rotate. The AuthGuard resolves these as
 * L2 principals (role `service_account`, tenantId = the owning org), so a
 * rotated or disabled token stops authenticating on the next request — the
 * same revocation bound as `nrv_live_` keys.
 *
 * Accountability rule (StrongDM/BeyondTrust posture): a service account has
 * no human owner, so every action it takes is attributed by the audit chain
 * to actor_type=api_key + actor_id=the SA row — creation/rotation events
 * carry the human actor for the ownership metadata.
 */
@Injectable()
export class OrgServiceAccountsService {
  constructor(
    @Inject(SERVICE_ACCOUNT_REPOSITORY) private readonly serviceAccounts: IServiceAccountRepository,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async list(orgId: string): Promise<ServiceAccountView[]> {
    const rows = await this.serviceAccounts.listServiceAccounts(orgId);
    return rows.map(toView);
  }

  async get(orgId: string, id: string): Promise<ServiceAccountView> {
    const row = await this.serviceAccounts.getServiceAccount(orgId, id);
    if (!row) {
      throw new NotFoundException('service account');
    }
    return toView(row);
  }

  async create(input: { orgId: string; name: string; description?: string; scopes: string[]; actorId: string }): Promise<{ view: ServiceAccountView; token: string; note: string }> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'a service account name is required' });
    }
    const scopes = this.validateScopes(input.scopes);

    const token = `${SERVICE_ACCOUNT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const inserted = await this.serviceAccounts.createServiceAccount({
      orgId: input.orgId,
      name,
      description: input.description?.slice(0, 512) ?? null,
      scopes,
      tokenHash: sha256Hex(token),
      tokenPrefix: token.slice(0, SERVICE_ACCOUNT_TOKEN_PREFIX.length + 8),
      tokenLastRotatedAt: new Date().toISOString(),
      createdBy: input.actorId,
    });
    await this.audit.add({
      action: 'org.service_account_created',
      resourceType: 'org_service_account',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name, scopes, token_prefix: inserted.tokenPrefix },
    });
    return { view: toView(inserted), token, note: 'store this token now — it is never shown again' };
  }

  /**
   * Rotate: mint a fresh token; the hash swap is guarded on the row's
   * current hash so a concurrent rotate cannot silently win. Disabling the
   * previous token is the swap itself — there is at most one live token.
   */
  async rotateToken(input: { orgId: string; id: string; actorId: string }): Promise<{ token: string; note: string }> {
    const sa = await this.serviceAccounts.getServiceAccount(input.orgId, input.id);
    if (!sa) {
      throw ApiError.notFound('service account');
    }
    if (sa.status !== 'active') {
      throw ApiError.conflict('service account is disabled — enable it before rotating');
    }
    const token = `${SERVICE_ACCOUNT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    // The repository returns false when the expected-hash predicate matched
    // nothing (stale hash) — the same 409 the pg compare-and-swap produced.
    const swapped = await this.serviceAccounts.rotateTokenHash({
      orgId: input.orgId,
      id: sa.id,
      expectedTokenHash: sa.tokenHash,
      tokenHash: sha256Hex(token),
      tokenPrefix: token.slice(0, SERVICE_ACCOUNT_TOKEN_PREFIX.length + 8),
      tokenLastRotatedAt: now,
      updatedAt: now,
    });
    if (!swapped) {
      throw ApiError.conflict('token changed concurrently — reload and retry');
    }
    await this.audit.add({
      action: 'org.service_account_token_rotated',
      resourceType: 'org_service_account',
      resourceId: sa.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { token_prefix: token.slice(0, SERVICE_ACCOUNT_TOKEN_PREFIX.length + 8) },
    });
    await this.events.emit(EngineEvents.ServiceAccountTokenRotated, { orgId: input.orgId, serviceAccountId: sa.id });
    return { token, note: 'store this token now — it is never shown again; the previous token is dead' };
  }

  /** Revoke just the token — the identity and its metadata stay. */
  async revokeToken(input: { orgId: string; id: string; actorId: string }): Promise<void> {
    const sa = await this.get(input.orgId, input.id);
    if (!sa.hasToken) {
      throw ApiError.conflict('service account has no active token');
    }
    const now = new Date().toISOString();
    await this.serviceAccounts.revokeToken(input.orgId, input.id, now);
    await this.audit.add({
      action: 'org.service_account_token_revoked',
      resourceType: 'org_service_account',
      resourceId: input.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  async disable(input: { orgId: string; id: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.id);
    const now = new Date().toISOString();
    await this.serviceAccounts.disableServiceAccount(input.orgId, input.id, now);
    await this.audit.add({
      action: 'org.service_account_disabled',
      resourceType: 'org_service_account',
      resourceId: input.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { note: 'token voided' },
    });
  }

  async enable(input: { orgId: string; id: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.id);
    const now = new Date().toISOString();
    await this.serviceAccounts.enableServiceAccount(input.orgId, input.id, now);
    await this.audit.add({
      action: 'org.service_account_enabled',
      resourceType: 'org_service_account',
      resourceId: input.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { note: 'token must be rotated to authenticate again' },
    });
  }

  async remove(input: { orgId: string; id: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.id);
    await this.serviceAccounts.removeServiceAccount(input.orgId, input.id);
    await this.audit.add({
      action: 'org.service_account_deleted',
      resourceType: 'org_service_account',
      resourceId: input.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  /**
   * AuthGuard lookup: resolve a `nrv_sa_` token by hash. Runs through the
   * repository's global platform-plane lookup — authentication happens
   * before any org context exists; the filter is the globally-unique
   * unguessable hash (uq_org_service_accounts_token_hash).
   */
  async validateByHash(tokenHash: string): Promise<{
    valid: boolean;
    serviceAccountId?: string;
    orgId?: string;
    name?: string;
    scopes?: string[];
    expiresAt?: string | null;
    reason?: 'unknown' | 'disabled' | 'expired' | 'no_token';
  }> {
    const row = await this.serviceAccounts.findByTokenHash(tokenHash);
    if (!row) {
      return { valid: false, reason: 'unknown' };
    }
    if (row.status !== 'active') {
      return { valid: false, reason: 'disabled', serviceAccountId: row.id, orgId: row.orgId };
    }
    if (row.tokenExpiresAt && Date.parse(row.tokenExpiresAt) <= Date.now()) {
      return { valid: false, reason: 'expired', serviceAccountId: row.id, orgId: row.orgId };
    }
    // Fire-and-forget usage telemetry (same discipline as L2 keys).
    void this.serviceAccounts.touchTokenLastUsed(row.id, new Date().toISOString()).catch(() => undefined);
    return {
      valid: true,
      serviceAccountId: row.id,
      orgId: row.orgId,
      name: row.name,
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expiresAt: row.tokenExpiresAt ?? null,
    };
  }

  private validateScopes(scopes: string[]): string[] {
    if (!Array.isArray(scopes) || scopes.length < 1) {
      throw ApiError.validation({ scopes: 'at least one scope is required' });
    }
    if (scopes.length > MAX_SCOPES) {
      throw ApiError.validation({ scopes: `at most ${MAX_SCOPES} scopes per service account` });
    }
    if (scopes.includes('*') && !scopes.every((s) => s === '*')) {
      throw ApiError.validation({ scopes: "'*' cannot be mixed with other scopes" });
    }
    for (const scope of scopes) {
      if (!SCOPE_RE.test(scope)) {
        throw ApiError.validation({ scopes: `invalid scope "${scope}" (lowercase segments, :, *, _ , - allowed)` });
      }
    }
    return [...new Set(scopes)];
  }
}

function toView(row: ServiceAccountRow): ServiceAccountView {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    hasToken: row.tokenHash !== null,
    tokenPrefix: row.tokenPrefix ?? null,
    tokenExpiresAt: row.tokenExpiresAt ?? null,
    tokenLastUsedAt: row.tokenLastUsedAt ?? null,
    tokenLastRotatedAt: row.tokenLastRotatedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
