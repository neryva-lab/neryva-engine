/**
 * `IEmailCodeRepository` — the persistence port for `email_login_codes`.
 *
 * Behavioral truth: `src/modules/identity/email-code.service.ts`.
 * Issue semantics are preserved exactly: `issue` voids ALL previous codes
 * for the account (unconditional `consumed_at` stamp), purges dead rows
 * (consumed OR expired), then inserts the new code — three separate
 * statements, not one transaction. `findLive` is the verify read (newest
 * 20 by creation, first hash match that is unconsumed); the caller
 * applies the expiry / attempt-ceiling policy. Consumption is the atomic
 * `consume` (exactly one concurrent consumer wins). Rate limiting stays
 * in the service (Redis), not in this port.
 */
export interface EmailLoginCode {
  accountId: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  requestIp: string | null;
}

export interface IEmailCodeRepository {
  issue(accountId: string, codeHash: string, requestIp: string | null, expiresAt: string, nowIso: string): Promise<void>;
  /**
   * The verify read: newest-first scan (by creation) of the account's
   * recent codes, returning the first row whose hash matches and which
   * is unconsumed — or null.
   */
  findLive(accountId: string, codeHash: string): Promise<EmailLoginCode | null>;
  /**
   * Atomic single-use consumption. Returns true for exactly one concurrent
   * consumer; false when the code is absent or already consumed.
   */
  consume(accountId: string, codeHash: string): Promise<boolean>;
  /** Increment the attempt counter on the account's unconsumed code rows. */
  registerFailedAttempt(accountId: string): Promise<void>;
}
