/**
 * `IAccountActionTokenRepository` — the persistence port for
 * `account_action_tokens` (the email-change / account-deletion token
 * lifecycle).
 *
 * Behavioral truth: `src/modules/identity/account-actions.service.ts`.
 * Like email codes, `issue` voids the previous unconsumed token of the
 * same kind and inserts the new one as separate statements. `peek` is the
 * verify-without-consuming read (unconsumed row or null); the caller
 * applies the expiry / attempt-ceiling policy. `consume` is the atomic
 * single-use compare-and-set — exactly one concurrent consumer wins.
 * The Redis issue-cooldown stays in the service.
 */
export interface AccountActionToken {
  id: string;
  accountId: string;
  kind: string;
  tokenHash: string;
  expiresAt: string;
  attempts: number;
  usedAt: string | null;
}

export interface IAccountActionTokenRepository {
  issue(accountId: string, kind: string, tokenHash: string, requestIp: string | null, expiresAt: string): Promise<void>;
  /** The live (unconsumed) row for a token hash + kind, or null. */
  peek(tokenHash: string, kind: string): Promise<AccountActionToken | null>;
  /**
   * Atomic single-use consumption by row id — stamps the row only when it
   * is still unused. Returns the row for exactly one concurrent consumer;
   * null when the id is unknown or already used. Mirrors the original
   * statement: `UPDATE … SET used_at WHERE id = row.id AND used_at IS NULL`.
   */
  consume(id: string, nowIso: string): Promise<AccountActionToken | null>;
  /** Increment the attempt counter on the token's unconsumed row. */
  registerFailedAttempt(tokenHash: string, kind: string): Promise<void>;
}
