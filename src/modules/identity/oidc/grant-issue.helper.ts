interface GrantModel {
  jti: string;
  addOIDCScope(scope: string): void;
  save(): Promise<void>;
}

interface GrantProvider {
  Grant: new (opts: { accountId: string; clientId: string }) => GrantModel;
}

/**
 * First-party grant issuance (login-only interactions, no consent screen).
 *
 * The provider refuses to issue codes against a scope-less grant
 * (`access_denied: ...no scope was granted`). Our /login/:uid interaction
 * finishes authentication AND records the grant in one step: the exact
 * scopes the client requested (from the stored interaction params) are
 * added to a fresh grant, whose id rides back as `consent.grantId` so the
 * resume step resolves a scoped grant. Pure first-party posture — there is
 * no third party to consent to.
 */
export async function issueFirstPartyGrant(
  provider: unknown,
  opts: { accountId: string; clientId: string; scope?: string },
): Promise<string> {
  const { Grant } = provider as GrantProvider;
  const grant = new Grant({ accountId: opts.accountId, clientId: opts.clientId });
  const scope = (opts.scope ?? '').split(' ').map((s) => s.trim()).filter(Boolean).join(' ');
  grant.addOIDCScope(scope === '' ? 'openid' : scope);
  await grant.save();
  return grant.jti;
}
