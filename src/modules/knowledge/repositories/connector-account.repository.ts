/**
 * Connector-account repository (P3) — the persistence port for connector
 * account lifecycle (`ConnectorsService`, the connector sync workers).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method except `findDueActiveAccounts` takes the
 * organization id explicitly (first parameter). `findDueActiveAccounts` is
 * BYPASS — the sync scheduler enumerates due accounts across orgs and
 * re-scopes per account before acting. The PostgreSQL implementation applies
 * the tenant via `DbService.withOrg` (RLS) or `withBypass`; the MongoDB
 * implementation applies it as an explicit `organization_id` predicate on
 * every tenant collection access.
 *
 * Row types are imported as *types only* from `../connectors.schema` — the
 * interface carries no drizzle runtime dependency.
 *
 * Sealed envelopes (`{ v: string }`) stay OPAQUE: the repository never
 * decrypts credentials. Anti-stale-snapshot posture is preserved by keeping
 * one method per use — each call re-reads the row fresh; the repository
 * never caches a sealed bundle.
 *
 * What stays OUT of the repository (still the service's job):
 * - envelope sealing/unsealing (the credential service)
 * - OAuth dance and token refresh (network)
 * - sync scheduling policy (the worker)
 */
import type { ConnectorAccount } from './repository-types';

export interface IConnectorAccountRepository {
  /**
   * Create or update a connector account by `(orgId, provider, displayName)`
   * (the unique key). Returns the resulting row. The sealed credential bundle
   * is written only when supplied — upsert never clears credentials it was
   * not given.
   */
  upsertAccount(
    orgId: string,
    input: {
      id: string;
      provider: string;
      displayName: string;
      config: Record<string, unknown>;
      credentialsSealed: { v: string } | null;
      createdBy: string;
    },
  ): Promise<ConnectorAccount>;

  /** Read one account, or null when not found. */
  findById(orgId: string, accountId: string): Promise<ConnectorAccount | null>;

  /** All connector accounts for the org (display-name ordered). */
  listAccounts(orgId: string): Promise<ConnectorAccount[]>;

  /**
   * Set the account state (+ optional last error). Throws notFound when the
   * account does not exist — state transitions on a missing account are a
   * caller bug, not a silent no-op.
   */
  updateState(
    orgId: string,
    accountId: string,
    state: 'active' | 'paused' | 'error',
    lastError: string | null,
  ): Promise<ConnectorAccount>;

  /**
   * Replace the sealed credential bundle — UNCONDITIONAL update, preserving
   * last-writer-wins. Deliberately no compare-and-set: credential rotation
   * and the OAuth refresh race both write the freshest bundle they hold,
   * and a CAS would turn a benign race into a failed refresh.
   */
  persistCredentialBundle(
    orgId: string,
    accountId: string,
    bundleSealed: { v: string },
  ): Promise<void>;

  /**
   * Advance the incremental-sync cursor: cursor + `lastSyncedAt = now()` +
   * state → `active` + `lastError = null` in one update (a successful sync
   * clears the error posture it replaces).
   */
  updateCursor(
    orgId: string,
    accountId: string,
    cursor: Record<string, unknown>,
  ): Promise<void>;

  /** Record a sync failure: state → `error`, `lastError = message`. */
  recordSyncError(orgId: string, accountId: string, message: string): Promise<void>;

  /**
   * BYPASS. Due active accounts across orgs: `state = 'active' AND provider
   * IN (...)`, capped at `limit`, oldest `lastSyncedAt` first. NO orgId
   * filter — the scheduler fans out per account and re-scopes withOrg before
   * doing tenant work.
   */
  findDueActiveAccounts(providers: string[], limit: number): Promise<ConnectorAccount[]>;
}
