/**
 * Kernel ports (dependency inversion): the kernel defines the interface,
 * platform modules bind the implementation. This keeps the "kernel imports
 * no module" rule intact while guards still reach module state through DI.
 */

/**
 * L1 session registry port (identity module implements). The L1 guard calls
 * this as the correctness fallback when the Redis deny-list misses (Redis
 * down or a revocation that predates the deny key's TTL).
 */
export const SESSION_REGISTRY_PORT = 'SESSION_REGISTRY_PORT';

export interface SessionRegistryPort {
  /**
   * Returns false when the session is revoked (oauth_sessions.revoked_at)
   * or when the account's sessions were globally revoked after the token
   * was issued. `sid` may be null when the JWT carries no sid claim —
   * implementations then evaluate the account-level check only.
   */
  isSessionActive(input: { accountId: string; sid: string | null; issuedAt: number }): Promise<boolean>;
}

/** No-op default (identity disabled): sessions cannot be verified. */
export class NullSessionRegistry implements SessionRegistryPort {
  async isSessionActive(): Promise<boolean> {
    return false;
  }
}

/**
 * Entitlement + membership port (organizations module implements). Used by
 * the entitlement guard and the org-roles guard.
 */
export const ORG_ACCESS_PORT = 'ORG_ACCESS_PORT';

export type EntitlementState = 'none' | 'trial' | 'active' | 'past_due' | 'suspended' | 'expired';

export interface OrgAccessPort {
  /** Membership role for (account, org), or null when not a member. */
  getMembershipRole(accountId: string, orgId: string): Promise<'owner' | 'admin' | 'billing' | 'developer' | 'reader' | null>;

  /** Entitlement state for (org, product); 'none' when no row exists. */
  getEntitlementState(orgId: string, product: string): Promise<EntitlementState>;
}

export class NullOrgAccess implements OrgAccessPort {
  async getMembershipRole(): Promise<null> {
    return null;
  }
  async getEntitlementState(): Promise<'none'> {
    return 'none';
  }
}

/**
 * L3 client registry port (identity implements): confirms a service client
 * exists and is not disabled, for guards that want DB-backed confirmation
 * beyond the JWT's own validity.
 */
export const SERVICE_CLIENT_PORT = 'SERVICE_CLIENT_PORT';

export interface ServiceClientPort {
  isActiveServiceClient(clientId: string): Promise<boolean>;
}

export class NullServiceClient implements ServiceClientPort {
  async isActiveServiceClient(): Promise<boolean> {
    return false;
  }
}

/**
 * Service-account token directory (organizations module implements): the L2
 * guard resolves `nrv_sa_` tokens by SHA-256 through this port before any
 * org context exists. Absent binding (organizations disabled) ⇒ fail closed.
 */
export const SERVICE_ACCOUNT_DIRECTORY_PORT = 'SERVICE_ACCOUNT_DIRECTORY_PORT';

export interface ServiceAccountTokenResolution {
  valid: boolean;
  serviceAccountId?: string;
  orgId?: string;
  name?: string;
  scopes?: string[];
  expiresAt?: string | null;
  reason?: 'unknown' | 'disabled' | 'expired' | 'no_token';
}

export interface ServiceAccountDirectoryPort {
  validateByHash(tokenHash: string): Promise<ServiceAccountTokenResolution>;
}

export class NullServiceAccountDirectory implements ServiceAccountDirectoryPort {
  async validateByHash(): Promise<{ valid: false; reason: 'unknown' }> {
    return { valid: false, reason: 'unknown' };
  }
}

/**
 * Platform staff directory (staff module implements): the per-request
 * authority for the staff axis (auth_plan.md D1). The `platform_role` JWT
 * claim is an optimization; THIS is what PlatformStaffGuard consults, so a
 * revocation or JIT expiry takes effect on the next request, not at token
 * expiry. Absent binding (staff module disabled) ⇒ fail closed.
 */
export const PLATFORM_STAFF_DIRECTORY_PORT = 'PLATFORM_STAFF_DIRECTORY_PORT';

export interface PlatformStaffResolution {
  /** Null when the account holds no unrevoked, unexpired staff binding. */
  role: 'super_admin' | 'tenant_admin' | 'operator' | 'auditor' | null;
  /** Present when role is non-null: when the JIT grant lapses. */
  expiresAt: string | null;
}

export interface PlatformStaffDirectoryPort {
  resolve(accountId: string): Promise<PlatformStaffResolution>;
}

export class NullPlatformStaffDirectory implements PlatformStaffDirectoryPort {
  async resolve(): Promise<PlatformStaffResolution> {
    return { role: null, expiresAt: null };
  }
}
