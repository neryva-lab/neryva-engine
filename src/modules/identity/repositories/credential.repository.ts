/**
 * `ICredentialRepository` — the persistence port for the password factor
 * (`account_credentials` rows with `kind = 'password'`).
 *
 * AUTH-3.2: password presence comes from the factor registry, not the
 * account row. The TOTP/MFA factor rows live behind `IMfaRepository`.
 *
 * Behavioral truth: `src/modules/identity/credentials.service.ts`.
 */
export interface ICredentialRepository {
  /** The stored argon2 hash for the password factor, or null when absent. */
  getPasswordHash(accountId: string): Promise<string | null>;
  /**
   * Set (insert-or-replace) the password factor. Throws an error with
   * `code === '23505'` if a concurrent insert wins the partial-unique race
   * and the row cannot be reconciled — the caller maps it to a conflict.
   */
  setPasswordHash(accountId: string, passwordHash: string): Promise<void>;
}
