import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { connectorOAuthApps } from '../connectors.schema';
import type { ConnectorOAuthApp } from './repository-types';
import type { IConnectorOAuthAppRepository } from './connector-oauth-app.repository';

/**
 * PostgreSQL implementation of `IConnectorOAuthAppRepository` (P3).
 *
 * Mechanical move of the `connector_oauth_apps` SQL from
 * `ConnectorsService`. Each method owns its transaction; no transaction
 * handle leaks.
 *
 * The sealed client secret (`enc:v1:` envelope) stays OPAQUE: the
 * repository stores and returns it sealed, and never decrypts.
 *
 * What stays OUT (still the service's job): provider allow-listing,
 * client_id/secret validation + trimming, envelope sealing/unsealing, the
 * OAuth dance and token refresh, audit writes.
 */
export class PgConnectorOAuthAppRepository implements IConnectorOAuthAppRepository {
  constructor(private readonly db: DbService) {}

  async upsertApp(
    orgId: string,
    input: { provider: string; clientId: string; clientSecretSealed: string; createdBy: string },
  ): Promise<{ id: string; provider: string }> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .insert(connectorOAuthApps)
        .values({
          id: uuidv7(),
          organizationId: orgId,
          provider: input.provider,
          clientId: input.clientId,
          clientSecretSealed: input.clientSecretSealed,
          createdBy: input.createdBy,
        })
        .onConflictDoUpdate({
          target: [connectorOAuthApps.organizationId, connectorOAuthApps.provider],
          set: {
            clientId: input.clientId,
            clientSecretSealed: input.clientSecretSealed,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning({ id: connectorOAuthApps.id, provider: connectorOAuthApps.provider });
      return { id: rows[0].id, provider: rows[0].provider };
    });
  }

  async listApps(orgId: string): Promise<ConnectorOAuthApp[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(connectorOAuthApps).where(eq(connectorOAuthApps.organizationId, orgId)),
    );
  }

  async findApp(orgId: string, provider: string): Promise<ConnectorOAuthApp | null> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(connectorOAuthApps)
        .where(and(eq(connectorOAuthApps.organizationId, orgId), eq(connectorOAuthApps.provider, provider)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async deleteApp(orgId: string, provider: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .delete(connectorOAuthApps)
        .where(and(eq(connectorOAuthApps.organizationId, orgId), eq(connectorOAuthApps.provider, provider))),
    );
  }
}
