/**
 * Connector-OAuth-app repository (P3) — the persistence port for org BYO
 * OAuth apps, one per provider (`ConnectorsService` OAuth dance + refresh).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from `../connectors.schema` — the
 * interface carries no drizzle runtime dependency. The sealed client secret
 * (`enc:v1:` envelope) stays OPAQUE: the repository stores and returns it
 * sealed, and never decrypts.
 *
 * What stays OUT of the repository (still the service's job):
 * - the OAuth dance and token refresh (network)
 * - envelope sealing/unsealing (the credential service)
 */
import type { ConnectorOAuthApp } from './repository-types';

export interface IConnectorOAuthAppRepository {
  /**
   * Create or replace the org's OAuth app for a provider (unique on
   * `(orgId, provider)`). `clientSecretSealed` arrives already sealed by the
   * service. Returns the app identity.
   */
  upsertApp(
    orgId: string,
    input: { provider: string; clientId: string; clientSecretSealed: string; createdBy: string },
  ): Promise<{ id: string; provider: string }>;

  /** All OAuth apps registered for the org. */
  listApps(orgId: string): Promise<ConnectorOAuthApp[]>;

  /** One provider's app, or null when the org has not registered one. */
  findApp(orgId: string, provider: string): Promise<ConnectorOAuthApp | null>;

  /** Delete the org's app for a provider (idempotent — no row, no error). */
  deleteApp(orgId: string, provider: string): Promise<void>;
}
