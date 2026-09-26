/**
 * PostgreSQL implementation of `IDeploymentSettingsRepository` (P3).
 *
 * Mechanical move of the `SettingsService` persistence units: byte-identical
 * queries, the same transaction boundaries. Validation, ladder
 * normalization, and the effective-settings composition stay in the service.
 */
import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { deploymentSettings } from '../schema';
import type { SettingsRow } from '../schema';
import type { IDeploymentSettingsRepository } from './settings.repository';

export class PgDeploymentSettingsRepository implements IDeploymentSettingsRepository {
  constructor(private readonly db: DbService) {}

  async getRow(orgId: string): Promise<SettingsRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(deploymentSettings).where(eq(deploymentSettings.orgId, orgId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async upsert(input: {
    orgId: string;
    defaultStrategy?: string;
    defaultLadder?: unknown[];
    autoRollback?: boolean;
    defaultCanaryWeight?: number;
    updatedBy: string;
    now: string;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(deploymentSettings)
        .values({
          orgId: input.orgId,
          ...(input.defaultStrategy !== undefined ? { defaultStrategy: input.defaultStrategy } : {}),
          ...(input.defaultLadder !== undefined ? { defaultLadder: input.defaultLadder } : {}),
          ...(input.autoRollback !== undefined ? { autoRollback: input.autoRollback ? 1 : 0 } : {}),
          ...(input.defaultCanaryWeight !== undefined ? { defaultCanaryWeight: input.defaultCanaryWeight } : {}),
          updatedBy: input.updatedBy,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: deploymentSettings.orgId,
          set: {
            ...(input.defaultStrategy !== undefined ? { defaultStrategy: input.defaultStrategy } : {}),
            ...(input.defaultLadder !== undefined ? { defaultLadder: input.defaultLadder } : {}),
            ...(input.autoRollback !== undefined ? { autoRollback: input.autoRollback ? 1 : 0 } : {}),
            ...(input.defaultCanaryWeight !== undefined ? { defaultCanaryWeight: input.defaultCanaryWeight } : {}),
            updatedBy: input.updatedBy,
            updatedAt: input.now,
          },
        }),
    );
  }
}
