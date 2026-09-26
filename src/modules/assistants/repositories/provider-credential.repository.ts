/**
 * Provider-credential repository (P3) — the persistence port for the
 * `provider_credentials` / `provider_enablements` aggregates
 * (`ProviderCredentialsService`: BYOK + platform credential lifecycle and
 * per-org provider enablement).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Secrecy boundary: the service seals the secret via envelopeEncrypt and
 * derives `secretFingerprint` and `externalRef` BEFORE calling — plaintext
 * secrets never cross this interface; the repository persists and returns
 * `ProviderCredential` ROWS (sealed ciphertext only) and the service maps
 * rows to caller-facing views (which never carry the sealed secret out).
 * Fingerprint derivation and secret comparison are service-side; the
 * repository matches only on `externalRef` for conflict detection.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `organization_id` predicate on every tenant
 * collection access (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module's
 * provider-credentials schema — the interface carries no drizzle runtime
 * dependency. Both implementations return objects matching these shapes
 * (the MongoDB implementation maps BSON documents, including Binary
 * subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, label/provider shape)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - envelope sealing/unsealing and fingerprint derivation (service-side)
 * - row → view mapping (the service strips sealed secrets from views)
 */
import type { ProviderCredential, ProviderEnablement } from '../provider-credentials.schema';

export interface IProviderCredentialRepository {
  /**
   * Provision a new credential (sealed secret only — never plaintext).
   * Throws conflict on duplicate (org, provider, external_ref).
   */
  provisionCredential(input: {
    orgId: string;
    provider: string;
    label: string;
    sealedSecret: string;
    secretFingerprint: string;
    externalRef: string;
    source: 'platform' | 'byok';
    createdBy: string;
  }): Promise<ProviderCredential>;

  /**
   * Atomic guarded rotate: replaces the sealed secret and fingerprint in
   * one guarded update. Throws notFound when unknown, conflict when the
   * credential is revoked.
   */
  rotateCredential(input: {
    orgId: string;
    credentialId: string;
    sealedSecret: string;
    secretFingerprint: string;
    externalRef: string;
    rotatedBy: string;
  }): Promise<ProviderCredential>;

  /** Revoke (never hard-delete); the sealed secret row is kept for audit. */
  revokeCredential(input: {
    orgId: string;
    credentialId: string;
    revocationReason: string | null;
    compromised: boolean;
  }): Promise<ProviderCredential>;

  listCredentials(orgId: string): Promise<ProviderCredential[]>;

  /** Providers with at least one ACTIVE credential in the org. */
  providersWithActiveCredentials(orgId: string): Promise<string[]>;

  listEnablements(orgId: string): Promise<ProviderEnablement[]>;

  /**
   * Upsert the per-org provider enablement (INSERT…ON CONFLICT on
   * (organization_id, provider)).
   */
  upsertEnablement(input: {
    orgId: string;
    provider: string;
    enabled: boolean;
    updatedBy: string;
  }): Promise<ProviderEnablement>;
}
