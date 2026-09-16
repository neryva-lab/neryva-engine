/**
 * Preselected-provider routing (the Auth0 `connection` / Keycloak
 * `kc_idp_hint` pattern) for the first-party OP.
 *
 * The console's provider buttons name the chosen provider on the authorize
 * URL (`?connection=google`). When the OP must interrupt for login, this
 * resolves WHERE the browser goes:
 *  - hint names a provider enabled on this deployment → straight to that
 *    provider's initiate route for THIS interaction (the generic chooser
 *    page is skipped — the user already chose on the product page).
 *  - anything else (absent, unknown, disabled, malformed) → the generic
 *    interaction page, which renders exactly the enabled providers.
 *
 * Security: the hint only selects among server-enabled providers (the
 * allowlist predicate is the deployment's own `socialProviders()` set).
 * The target is built from the server-issued interaction uid + the
 * allowlisted key — never from raw user input — so there is no open
 * redirect. Initiate re-binds the uid to the live OP interaction
 * (`interactionDetails`) before leaving for the IdP, so a forged uid
 * dies with a 410 instead of a redirect.
 */
export function interactionEntryUrl(
  authorizeParams: Record<string, unknown> | null | undefined,
  uid: string,
  isProviderEnabled: (key: string) => boolean,
): string {
  const fallback = `/login/${uid}`;
  const raw = authorizeParams?.['connection'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string') {
    return fallback;
  }
  const key = first.trim().toLowerCase();
  if (key.length === 0 || !isProviderEnabled(key)) {
    return fallback;
  }
  return `/login/${uid}/social/${key}`;
}
