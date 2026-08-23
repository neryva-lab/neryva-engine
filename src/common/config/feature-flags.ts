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
}
