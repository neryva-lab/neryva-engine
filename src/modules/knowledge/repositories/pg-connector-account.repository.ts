import { and, asc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { connectorAccounts } from '../connectors.schema';
import type { ConnectorAccount } from './repository-types';
import type { IConnectorAccountRepository } from './connector-account.repository';

/**
 * PostgreSQL implementation of `IConnectorAccountRepository` (P3).
 *
 * Mechanical move of the `connector_accounts` SQL from `ConnectorsService`
 * (lifecycle) and the sync scheduler (`dueAccounts`). Each method owns its
 * transaction; no transaction handle leaks.
 *
 * Sealed envelopes (`{ v: string }`) stay OPAQUE: the repository never
 * decrypts credentials. Anti-stale-snapshot posture is preserved by keeping
 * one method per use — each call re-reads the row fresh.
 *
 * INTERFACE-MANDATED ORDERING (documented): `listAccounts` is
 * display-name-ordered and `findDueActiveAccounts` is oldest-
 * `lastSyncedAt`-first per the interface; the old code had no ORDER BY
 * (undefined order). The ordering is now deterministic.
 *
 * BEHAVIOR NOTE (documented): `updateState` sets `lastError`
 * unconditionally (null clears), matching the interface's "(+ optional
 * last error)" and the MongoDB implementation. The old `setState` left
 * `lastError` untouched; a manual state change now clears it.
 *
 * What stays OUT (still the service's job): envelope sealing/unsealing,
 * the sharepoint credential pre-processing, OAuth dance/token refresh,
 * input validation, audit writes.
 */
export class PgConnectorAccountRepository implements IConnectorAccountRepository {
  constructor(private readonly db: DbService) {}

  async upsertAccount(
    orgId: string,
    input: {
      id: string;
      provider: string;
      displayName: string;
      config: Record<string, unknown>;
      credentialsSealed: { v: string } | null;
      createdBy: string;
    },
  ): Promise<ConnectorAccount> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .insert(connectorAccounts)
        .values({
          id: input.id,
          organizationId: orgId,
          provider: input.provider,
          displayName: input.displayName,
          config: input.config,
          // The sealed bundle is written only when supplied — upsert never
          // clears credentials it was not given.
          ...(input.credentialsSealed ? { credentialsSealed: input.credentialsSealed } : {}),
          createdBy: input.createdBy,
        })
        .onConflictDoUpdate({
          target: [connectorAccounts.organizationId, connectorAccounts.provider, connectorAccounts.displayName],
          set: {
            config: input.config,
            ...(input.credentialsSealed ? { credentialsSealed: input.credentialsSealed } : {}),
            state: 'active',
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return rows[0];
    });
  }

  async findById(orgId: string, accountId: string): Promise<ConnectorAccount | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(connectorAccounts)
        .where(and(eq(connectorAccounts.organizationId, orgId), eq(connectorAccounts.id, accountId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async listAccounts(orgId: string): Promise<ConnectorAccount[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.organizationId, orgId))
        .orderBy(asc(connectorAccounts.displayName)),
    );
  }

  async updateState(
    orgId: string,
    accountId: string,
    state: 'active' | 'paused' | 'error',
    lastError: string | null,
  ): Promise<ConnectorAccount> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .update(connectorAccounts)
        .set({ state, lastError, updatedAt: new Date().toISOString() })
        .where(and(eq(connectorAccounts.organizationId, orgId), eq(connectorAccounts.id, accountId)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('connector account');
      }
      return rows[0];
    });
  }

  async persistCredentialBundle(
    orgId: string,
    accountId: string,
    bundleSealed: { v: string },
  ): Promise<void> {
    // UNCONDITIONAL update, preserving last-writer-wins. Deliberately no
    // compare-and-set: credential rotation and the OAuth refresh race both
    // write the freshest bundle they hold, and a CAS would turn a benign
    // race into a failed refresh.
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(connectorAccounts)
        .set({ credentialsSealed: bundleSealed, updatedAt: new Date().toISOString() })
        .where(eq(connectorAccounts.id, accountId));
    });
  }

  async updateCursor(
    orgId: string,
    accountId: string,
    cursor: Record<string, unknown>,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(connectorAccounts)
        .set({
          cursor,
          lastSyncedAt: new Date().toISOString(),
          state: 'active',
          lastError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(connectorAccounts.id, accountId));
    });
  }

  async recordSyncError(orgId: string, accountId: string, message: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx
        .update(connectorAccounts)
        .set({ state: 'error', lastError: message, updatedAt: new Date().toISOString() })
        .where(eq(connectorAccounts.id, accountId));
    });
  }

  async findDueActiveAccounts(providers: string[], limit: number): Promise<ConnectorAccount[]> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .select()
        .from(connectorAccounts)
        .where(and(eq(connectorAccounts.state, 'active'), inArray(connectorAccounts.provider, providers)))
        .orderBy(asc(connectorAccounts.lastSyncedAt))
        .limit(limit);
      return rows;
    });
  }
}
