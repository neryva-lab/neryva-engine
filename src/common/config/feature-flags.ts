import { env } from './env';

/**
 * Per-module feature flags (ADR-005 M1/M4 pattern). Every module registers
 * itself behind one flag; a disabled module contributes zero routes and zero
 * behavior. The startup self-check (kernel K-5) refuses configurations where
 * an enabled module depends on a disabled one.
 */
export const ModuleFlags = {
  get corporate(): boolean {
    return env.MODULES__CORPORATE_ENABLED;
  },
  get identity(): boolean {
    return env.MODULES__IDENTITY_ENABLED;
  },
  get organizations(): boolean {
    return env.MODULES__ORGANIZATIONS_ENABLED;
  },
  get console(): boolean {
    return env.MODULES__CONSOLE_ENABLED;
  },
  get billing(): boolean {
    return env.MODULES__BILLING_ENABLED;
  },
  get agentStudio(): boolean {
    return env.MODULES__AGENT_STUDIO_ENABLED;
  },
  get deployment(): boolean {
    return env.MODULES__DEPLOYMENT_ENABLED;
  },
  get keys(): boolean {
    return env.MODULES__KEYS_ENABLED;
  },
  get configPublish(): boolean {
    return env.MODULES__CONFIG_PUBLISH_ENABLED;
  },
  get satellites(): boolean {
    return env.MODULES__SATELLITES_ENABLED;
  },
} as const;

/** Dependency rules enforced at boot (fail loudly, never at request time). */
export function validateFlagMatrix(): void {
  // Identity sends login codes through the corporate email service (E-1).
  if (ModuleFlags.identity && !ModuleFlags.corporate) {
    throw new Error('MODULES__IDENTITY_ENABLED requires MODULES__CORPORATE_ENABLED (login-code delivery uses the corporate email service)');
  }
  // Organizations' members are identity accounts; its guards need L1.
  if (ModuleFlags.organizations && !ModuleFlags.identity) {
    throw new Error('MODULES__ORGANIZATIONS_ENABLED requires MODULES__IDENTITY_ENABLED (memberships reference accounts)');
  }
  // The console renders cards from org entitlement states and the org header.
  if (ModuleFlags.console && !ModuleFlags.organizations) {
    throw new Error('MODULES__CONSOLE_ENABLED requires MODULES__ORGANIZATIONS_ENABLED (home cards resolve entitlement states)');
  }
  // Billing validates product tags against the manifest registry and joins
  // entitlement state onto its ledgers.
  if (ModuleFlags.billing && !(ModuleFlags.console && ModuleFlags.organizations)) {
    throw new Error('MODULES__BILLING_ENABLED requires MODULES__CONSOLE_ENABLED and MODULES__ORGANIZATIONS_ENABLED (ingest validates registered product tags; ledgers join entitlement state)');
  }
  // The studio product furniture registers its summary through the console
  // and computes KPIs from the billing metering plane.
  if (ModuleFlags.agentStudio && !(ModuleFlags.console && ModuleFlags.billing)) {
    throw new Error('MODULES__AGENT_STUDIO_ENABLED requires MODULES__CONSOLE_ENABLED and MODULES__BILLING_ENABLED (product registration + usage KPIs)');
  }
  // Deployment registers through the console and reads cost from billing.
  if (ModuleFlags.deployment && !(ModuleFlags.console && ModuleFlags.billing)) {
    throw new Error('MODULES__DEPLOYMENT_ENABLED requires MODULES__CONSOLE_ENABLED and MODULES__BILLING_ENABLED (product registration + cost views)');
  }
  // Key management rides the org roles/membership guards.
  if (ModuleFlags.keys && !ModuleFlags.organizations) {
    throw new Error('MODULES__KEYS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED (console key CRUD is role-guarded)');
  }
  // Config publishing fans out through the satellite registry; its console
  // zone rides the org guards.
  if (ModuleFlags.configPublish && !(ModuleFlags.organizations && ModuleFlags.satellites)) {
    throw new Error('MODULES__CONFIG_PUBLISH_ENABLED requires MODULES__ORGANIZATIONS_ENABLED and MODULES__SATELLITES_ENABLED (console guards + notification fanout)');
  }
  // Satellites heartbeat on L3 service tokens (identity's OP issues them).
  if (ModuleFlags.satellites && !ModuleFlags.identity) {
    throw new Error('MODULES__SATELLITES_ENABLED requires MODULES__IDENTITY_ENABLED (heartbeats authenticate on L3)');
  }
}
