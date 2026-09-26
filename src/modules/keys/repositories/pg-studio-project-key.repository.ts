import { eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { studioProjectKeys } from '../../studio-furniture/schema';
import type {
  IStudioProjectKeyRepository,
  ProjectKeyBindingRow,
} from './keys.repository';

/**
 * PostgreSQL implementation of `IStudioProjectKeyRepository` (P3).
 *
 * Mechanical move of the `KeysService` K-2 project-binding units: the
 * binding insert runs inside `DbService.withOrg` (the pre-extraction code
 * inserted the binding in its own withOrg unit at issue time); the binding
 * read keeps the pre-extraction filter (`api_key_id` only — RLS scopes the
 * tenant on the pg lane).
 */
export class PgStudioProjectKeyRepository implements IStudioProjectKeyRepository {
  constructor(private readonly db: DbService) {}

  async bindKeyToProject(input: {
    orgId: string;
    apiKeyId: string;
    projectId: string;
    boundBy: string;
  }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(studioProjectKeys)
        .values({
          orgId: input.orgId,
          apiKeyId: input.apiKeyId,
          projectId: input.projectId,
          boundBy: input.boundBy,
        })
        .onConflictDoNothing(),
    );
  }

  async getBindingByKeyId(orgId: string, apiKeyId: string): Promise<ProjectKeyBindingRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(studioProjectKeys).where(eq(studioProjectKeys.apiKeyId, apiKeyId)).limit(1),
    );
    return rows[0] ?? null;
  }
}
