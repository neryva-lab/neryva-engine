/**
 * Organization role model — persistence-free.
 *
 * `OrgRole` and the role allowlists are domain vocabulary, not persistence:
 * they live here (no Drizzle/Mongo imports) so services and controllers can
 * validate roles without pulling the Drizzle schema module into their
 * runtime graph. `schema.ts` re-exports them for compatibility.
 */
export type OrgRole = 'owner' | 'admin' | 'billing' | 'developer' | 'reader';

export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'billing', 'developer', 'reader'] as const;

/** Roles that may be granted by invitation — ownership arrives only via transfer. */
export const INVITABLE_ROLES: readonly OrgRole[] = ['admin', 'billing', 'developer', 'reader'] as const;
