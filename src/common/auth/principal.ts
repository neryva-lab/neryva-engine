/**
 * The five token layers (doc-06 §6), as a discriminated principal union.
 * A token from one layer is never accepted on another layer's routes: the
 * composite guard only tries the layers a route declares via @AuthLayer.
 */
export type AuthLayerKind = 'l1' | 'l2' | 'l3';

export type PlatformRole = 'super_admin' | 'tenant_admin' | 'operator' | 'auditor';
export type OrgRole = 'owner' | 'admin' | 'billing' | 'developer' | 'reader';

export interface L1Principal {
  kind: 'l1';
  id: string; // account id (sub)
  sessionId: string | null; // sid claim when present
  email: string | null;
  platformRole: PlatformRole | null;
  scopes: string[];
  /** True for staff impersonation tokens (act claim): READ-ONLY posture — no step-up, no org mutations. */
  imp?: boolean;
}

export interface L2Principal {
  kind: 'l2';
  id: string; // api_keys.id or org_service_accounts.id
  name: string;
  role: string; // platform role from the key row ('service_account' for nrv_sa_ tokens)
  tenantId: string | null;
  scopes: string[];
  /** True only for the break-glass bootstrap key. */
  bootstrap: boolean;
  /** True when the principal is an org service account (nrv_sa_ token). */
  serviceAccount?: boolean;
}

export interface L3Principal {
  kind: 'l3';
  id: string; // oauth client id (service)
  scopes: string[];
}

export type Principal = L1Principal | L2Principal | L3Principal;

export function hasScope(principal: Principal, required: string | string[]): boolean {
  const requiredList = Array.isArray(required) ? required : [required];
  if (principal.scopes.includes('*')) {
    return true;
  }
  return requiredList.every((scope) => principal.scopes.includes(scope));
}

/**
 * Map an internal-surface principal to its satellite registry key
 * (svc-agent-runtime → agent-runtime). Non-satellite principals (L2 staff
 * keys, the bootstrap key) return null. Lives here so any module can map
 * without importing the satellites module (flag discipline preserved).
 */
export function satelliteKeyOf(principal: Principal): string | null {
  if (principal.kind === 'l3') {
    return principal.id.startsWith('svc-') ? principal.id.slice(4) : principal.id;
  }
  if (principal.kind === 'l2' && !principal.bootstrap && principal.id.startsWith('svc-')) {
    return principal.id.slice(4);
  }
  return null;
}
