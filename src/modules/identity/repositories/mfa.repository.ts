/**
 * `IMfaRepository` — the persistence port for the MFA factor registry:
 * `account_credentials` rows with `kind = 'totp' | 'totp_pending'` plus
 * `account_recovery_codes`, and the `accounts.mfa_level` transitions that
 * belong to the MFA lifecycle.
 *
 * The multi-row transitions (`activate`, `disable`,
 * `regenerateRecoveryCodes`) each own their transaction — callers never
 * see a transaction handle.
 *
 * Behavioral truth: `src/modules/identity/mfa.service.ts`.
 */
export interface TotpCredential {
  id: string;
  kind: string;
  totpSecretEnvelope: string | null;
  lastUsedAt: string | null;
}

export interface IMfaRepository {
  /** The active TOTP factor, or null when MFA is not active. */
  findActive(accountId: string): Promise<TotpCredential | null>;
  /** The pending (enrolled-but-not-yet-activated) TOTP factor, or null. */
  findPending(accountId: string): Promise<TotpCredential | null>;
  /** Insert-or-replace the pending enrollment secret (single statement). */
  enrollPending(accountId: string, secretEnvelope: string): Promise<void>;
  /**
   * Activate MFA: delete the pending row, upsert the active TOTP row, and
   * set `accounts.mfa_level = 'totp'` — one transaction.
   */
  activate(accountId: string, secretEnvelope: string, nowIso: string): Promise<void>;
  /**
   * Disable MFA: delete TOTP + pending rows, delete all unused recovery
   * codes, and reset `accounts.mfa_level = 'none'` — one transaction.
   */
  disable(accountId: string, nowIso: string): Promise<void>;
  touchLastUsed(credentialId: string, nowIso: string): Promise<void>;
  /**
   * Replace the recovery-code set: delete all codes for the account and
   * insert the new hashes — one transaction. Returns the inserted count.
   */
  regenerateRecoveryCodes(accountId: string, codeHashes: string[], nowIso: string): Promise<number>;
  /**
   * Atomic single-use recovery-code consumption. Exactly one concurrent
   * consumer wins; returns true on the win, false when the code is absent
   * or already used.
   */
  consumeRecoveryCode(accountId: string, codeHash: string, nowIso: string): Promise<boolean>;
  countUnusedRecoveryCodes(accountId: string): Promise<number>;
  mfaLevel(accountId: string): Promise<string>;
}
