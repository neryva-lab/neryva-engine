/**
 * Secrets vault repository (P3) — the persistence port for `SecretsService`.
 *
 * Read discipline is unchanged: the repository moves rows; envelope
 * encryption/decryption, key derivation (`derivePreview`), expiry/cadence
 * validation, and the plaintext-never-to-console guarantee all stay in the
 * service. The repository carries ciphertext only.
 *
 * Each method owns its transaction. The `set` upsert (insert-or-overwrite
 * with the version bump) is one atomic unit on both lanes.
 *
 * Tenant discipline: every method takes the organization id explicitly.
 * `scanExpiring` is platform-plane (no tenant scope) like the current
 * `withBypass` call.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (key pattern, value length, expiry/cadence shapes)
 * - envelope encryption/decryption (`envelopeEncrypt`/`envelopeDecrypt`)
 * - `derivePreview` and the metadata-only projection
 * - audit writes
 */
export interface SecretMetadata {
  id: string;
  environment_id: string;
  key: string;
  preview: string | null;
  kms_ref: string | null;
  version: number;
  expires_at: string | null;
  rotation_interval_days: number | null;
  rotated_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface ExpiringSecret {
  orgId: string;
  environmentId: string;
  key: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  intervalDays: number | null;
}

export interface IDeploymentSecretRepository {
  /** Metadata only — never ciphertext, never plaintext. */
  listMetadata(orgId: string, environmentId?: string): Promise<SecretMetadata[]>;

  /** Vault totals for the secrets page header. */
  stats(orgId: string): Promise<{ total: number; rotated_30d: number; expiring_soon: number }>;

  /** Latest `deployment.secret*` audit timestamp for the org, or null. */
  lastSecretAuditAt(orgId: string): Promise<string | null>;

  /**
   * Insert-or-overwrite (the `(environment_id, key)` unique claim): an
   * overwrite bumps `version` and restamps `rotated_at`. Atomic.
   */
  upsertSecret(input: {
    orgId: string;
    environmentId: string;
    key: string;
    valueCiphertext: string;
    kmsRef: string | null;
    preview: string;
    expiresAt: string | null;
    rotationIntervalDays: number | null;
    now: string;
  }): Promise<void>;

  /** Secret identity for rotate/remove; null when missing. */
  findById(orgId: string, secretId: string): Promise<{ id: string; environmentId: string; key: string } | null>;

  /** Replace the sealed value (version bump + rotated_at restamp). */
  rotateSecret(input: { orgId: string; secretId: string; valueCiphertext: string; preview: string; now: string }): Promise<void>;

  deleteSecret(orgId: string, secretId: string): Promise<void>;

  /** Ciphertext pairs for the runtime resolve plane. */
  fetchCiphertexts(orgId: string, environmentId: string): Promise<Array<{ key: string; valueCiphertext: string }>>;

  /** Bump `last_used_at` after a successful resolve. */
  touchLastUsed(orgId: string, environmentId: string, now: string): Promise<void>;

  /** The daily expiring scan (platform-plane, all orgs). */
  scanExpiring(withinDays: number): Promise<ExpiringSecret[]>;
}
