import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { modelCatalogEntries } from '../model-catalog.schema';
import type { ModelCapabilities, ModelCatalogEntry } from '../model-catalog.schema';
import { publishedConfigs } from '../../config-publish/config-publish.schema';
import type { IModelCatalogRepository } from './model-catalog.repository';

/**
 * PostgreSQL implementation of `IModelCatalogRepository` (P3).
 *
 * Mechanical move of the `ModelCatalogService` catalog units: every method
 * owns its unit of work on `DbService.root` (GLOBAL tables — no RLS; single
 * statements are their own unit). No transaction handle leaks through this
 * interface.
 *
 * What stays OUT (still the service's job): input validation (provider /
 * model-id format, status transitions), tracing spans, audit writes
 * (replayed by the service from inputs + results), residency enforcement
 * decisions.
 */
export class PgModelCatalogRepository implements IModelCatalogRepository {
  private static readonly LIST_CAP = 500;

  constructor(private readonly db: DbService) {}

  /** Upsert by (provider, modelId): insert or update the mutable columns. */
  async upsertEntry(input: {
    provider: string;
    modelId: string;
    displayName: string;
    contextWindowTokens?: number | null;
    maxOutputTokens?: number | null;
    capabilities?: ModelCapabilities;
    residency?: string | null;
  }): Promise<ModelCatalogEntry> {
    const rows = await this.db.root
      .insert(modelCatalogEntries)
      .values({
        id: uuidv7(),
        provider: input.provider,
        modelId: input.modelId,
        displayName: input.displayName,
        contextWindowTokens: input.contextWindowTokens ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        capabilities: input.capabilities ?? {},
        residency: input.residency ?? null,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [modelCatalogEntries.provider, modelCatalogEntries.modelId],
        set: {
          displayName: input.displayName,
          contextWindowTokens: input.contextWindowTokens ?? null,
          maxOutputTokens: input.maxOutputTokens ?? null,
          capabilities: input.capabilities ?? {},
          residency: input.residency ?? null,
          status: 'active',
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();
    return rows[0];
  }

  async listEntries(status?: string): Promise<ModelCatalogEntry[]> {
    if (status !== undefined) {
      return this.db.root
        .select()
        .from(modelCatalogEntries)
        .where(eq(modelCatalogEntries.status, status))
        .limit(PgModelCatalogRepository.LIST_CAP);
    }
    return this.db.root
      .select()
      .from(modelCatalogEntries)
      .limit(PgModelCatalogRepository.LIST_CAP);
  }

  /** Status flip; throws notFound when the entry is missing. */
  async setEntryStatus(input: {
    entryId: string;
    status: string;
  }): Promise<ModelCatalogEntry> {
    const rows = await this.db.root
      .update(modelCatalogEntries)
      .set({ status: input.status, updatedAt: new Date().toISOString() })
      .where(eq(modelCatalogEntries.id, input.entryId))
      .returning();
    if (rows.length === 0) {
      throw ApiError.notFound('model catalog entry');
    }
    return rows[0];
  }

  /** Distinct (provider, modelId) pairs referenced by active entries. */
  async listActiveRefs(): Promise<Array<{ provider: string; modelId: string }>> {
    return this.db.root
      .select({
        provider: modelCatalogEntries.provider,
        modelId: modelCatalogEntries.modelId,
      })
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.status, 'active'));
  }

  /**
   * FOREIGN-OWNED read (config-publish's `published_configs`): the org's
   * residency pin. config-publish owns this table (its migration, its
   * writes); the catalog reads it directly here only because the catalog
   * service needs the pin today — a candidate for delegation to
   * config-publish's port later. Unset pin (no row / no residency key /
   * read failure) = 'default' (permissive), exactly as the service did.
   */
  async orgResidencyPin(orgId: string): Promise<string> {
    try {
      const rows = await this.db.root
        .select({ payload: publishedConfigs.payload })
        .from(publishedConfigs)
        .where(
          and(
            eq(publishedConfigs.orgId, orgId),
            eq(publishedConfigs.scope, 'knowledge_config'),
          ),
        )
        .limit(1);
      const raw = (rows[0]?.payload as { residency?: string } | undefined)?.residency;
      if (raw) return raw;
    } catch {
      // keep default — the publish-time gate is the hard enforcement
    }
    return 'default';
  }
}
