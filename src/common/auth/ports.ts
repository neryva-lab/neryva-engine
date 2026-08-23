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
