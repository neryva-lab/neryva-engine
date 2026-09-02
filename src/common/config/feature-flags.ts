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
  get webhooks(): boolean {
    return env.MODULES__WEBHOOKS_ENABLED;
  },
  get notifications(): boolean {
    return env.MODULES__NOTIFICATIONS_ENABLED;
  },
  get staff(): boolean {
    return env.MODULES__STAFF_ENABLED;
  },
  get assistants(): boolean {
    return env.MODULES__ASSISTANTS_ENABLED;
  },
  get conversations(): boolean {
    return env.MODULES__CONVERSATIONS_ENABLED;
  },
  get mcp(): boolean {
    return env.MODULES__MCP_ENABLED;
  },
  get knowledge(): boolean {
    return env.MODULES__KNOWLEDGE_ENABLED;
  },
  get workers(): boolean {
    return env.WORKERS__OUTBOX_ENABLED;
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
  // zone rides the org guards, and product tags validate against the
  // manifest registry (console module).
  if (ModuleFlags.configPublish && !(ModuleFlags.organizations && ModuleFlags.satellites && ModuleFlags.console)) {
    throw new Error('MODULES__CONFIG_PUBLISH_ENABLED requires MODULES__ORGANIZATIONS_ENABLED, MODULES__SATELLITES_ENABLED and MODULES__CONSOLE_ENABLED (org guards + fanout + manifest registry)');
  }
  // Satellites heartbeat on L3 service tokens (identity's OP issues them).
  if (ModuleFlags.satellites && !ModuleFlags.identity) {
    throw new Error('MODULES__SATELLITES_ENABLED requires MODULES__IDENTITY_ENABLED (heartbeats authenticate on L3)');
  }
  // Webhook delivery targets org-owned endpoints behind the roles guard.
  if (ModuleFlags.webhooks && !ModuleFlags.organizations) {
    throw new Error('MODULES__WEBHOOKS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED (webhook management is org furniture)');
  }
  // Notifications fan out to org members + send email through corporate.
  if (ModuleFlags.notifications && !(ModuleFlags.organizations && ModuleFlags.corporate)) {
    throw new Error('MODULES__NOTIFICATIONS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED and MODULES__CORPORATE_ENABLED (role fan-out + email transport)');
  }
  // The staff overlay reads identity/org/billing/satellite state.
  if (ModuleFlags.staff && !(ModuleFlags.organizations && ModuleFlags.billing)) {
    throw new Error('MODULES__STAFF_ENABLED requires MODULES__ORGANIZATIONS_ENABLED and MODULES__BILLING_ENABLED (org lookup, audit, usage)');
  }
  // Assistants need organizations (+ console for manifest/product checks when publishing).
  if (ModuleFlags.assistants && !ModuleFlags.organizations) {
    throw new Error('MODULES__ASSISTANTS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED (assistant tenancy)');
  }
  // Conversations pin the assistant's active published version + policy snapshot at acceptance.
  if (ModuleFlags.conversations && !(ModuleFlags.organizations && ModuleFlags.assistants)) {
    throw new Error('MODULES__CONVERSATIONS_ENABLED requires MODULES__ORGANIZATIONS_ENABLED and MODULES__ASSISTANTS_ENABLED (runs pin assistant versions)');
  }
  // The MCP authority surface serves runs; identity issues the workload identities.
  if (ModuleFlags.mcp && !(ModuleFlags.conversations && ModuleFlags.identity)) {
    throw new Error('MODULES__MCP_ENABLED requires MODULES__CONVERSATIONS_ENABLED and MODULES__IDENTITY_ENABLED (authority over runs + workload identities)');
  }
}
