/**
 * `IIdentityLinkRepository` — the persistence port for `account_identities`
 * (federated social identities). The social-account linking POLICY
 * (subject-first, verified-email link, one-way binding) stays in
 * `SocialAccountService`; this port is the dumb store underneath it.
 *
 * Behavioral truth: `src/modules/identity/social/social-account.service.ts`.
 */
export interface IdentityLink {
  id: string;
  accountId: string;
  provider: string;
  subject: string;
  email: string | null;
  linkedAt: string;
  lastUsedAt: string | null;
}

export interface IIdentityLinkRepository {
  /** The account bound to a (provider, subject) pair — the subject is the truth. */
  findAccountId(provider: string, subject: string): Promise<string | null>;
  touchLastUsed(provider: string, subject: string, email: string | null, nowIso: string): Promise<void>;
  /** Insert-or-refresh the federated identity row. */
  link(accountId: string, provider: string, subject: string, email: string | null, nowIso: string): Promise<void>;
  listByAccount(accountId: string): Promise<IdentityLink[]>;
  findById(identityId: string): Promise<IdentityLink | null>;
  deleteById(identityId: string): Promise<void>;
}
