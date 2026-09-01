/**
 * The OIDC provider injection token lives in its own module so the identity
 * module and the OP-attached controllers never import each other for it —
 * importing the token from identity.module creates a require cycle that
 * deadlocks module evaluation (TDZ on the const before the module body runs).
 */
export const OIDC_PROVIDER = 'OIDC_PROVIDER';
