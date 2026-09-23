import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { modelCatalogEntries, ModelCatalogEntry, MODEL_CATALOG_STATUSES, ModelCapabilities } from './model-catalog.schema';
import { ProviderCredentialsService } from './provider-credentials.service';
import { publishedConfigs } from '../config-publish/config-publish.schema';

/**
 * Platform model catalog — REL-1.6 (release_ledger.md). GLOBAL, staff-managed
 * (drizzle/0051, price_catalog posture). Answers "does this model exist on
 * the platform and can this org reach it" — the org's published
 * `model_catalog` config answers "did this org allow it" and stays the
 * governance layer above.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GAP-09 distinction, exported pure for unit tests. Given the models a
 * template requires but the org's published catalog does not allow, split
 * them by WHERE the blocker sits:
 *  - notInPlatform: the model does not exist in the seeded platform catalog
 *    (a real misconfiguration — the fix is catalog/platform side);
 *  - noKey: the model exists platform-side but this org has no active
 *    credential or is administratively disabled (the fix is enabling/
 *    provisioning on the org side);
 *  - governanceOnly: the model exists AND is reachable, but the org's own
 *    model_catalog governance excludes it (deliberate org choice).
 */
export function partitionModelGaps(
  missing: string[],
  platformModels: Set<string>,
  credentialProviders: Set<string>,
): { notInPlatform: string[]; noKey: string[]; governanceOnly: string[] } {
  const notInPlatform: string[] = [];
  const noKey: string[] = [];
  const governanceOnly: string[] = [];
  for (const ref of missing) {
    const slash = ref.indexOf('/');
    const provider = slash === -1 ? ref : ref.slice(0, slash);
    if (!platformModels.has(ref)) {
      notInPlatform.push(ref);
    } else if (!credentialProviders.has(provider)) {
      noKey.push(ref);
    } else {
      governanceOnly.push(ref);
    }
  }
  return { notInPlatform, noKey, governanceOnly };
}

/**
 * A2-40 — pure publish-gate rule, exported for unit tests. Given the
 * assistant's `allowed_models` refs and the active platform catalog (as
 * `provider/model` strings), return the refs that name no model the platform
 * has ever heard of. Bare refs without a provider slash predate the catalog
 * and keep the old structural-only posture (not judged here).
 */
export function unknownPlatformModels(allowed: string[], platformRefs: Set<string>): string[] {
  return allowed.filter((ref) => ref.includes('/') && !platformRefs.has(ref));
}

export interface ModelAvailabilityRow {  provider: string;
  model_id: string;
  display_name: string;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
  capabilities: ModelCapabilities;
  residency: string | null;
  usable: boolean;
  /** Why not usable — machine-readable, mirrors the compatibility reason vocabulary. */
  reasons: string[];
}

@Injectable()
export class ModelCatalogService {
  private static readonly LIST_CAP = 500;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  /** Staff upsert (idempotent by (provider, model_id)); every change audited. */
  async upsertEntry(input: {
    provider: string;
    modelId: string;
    displayName: string;
    contextWindowTokens?: number | null;
    maxOutputTokens?: number | null;
    capabilities?: ModelCapabilities;
    residency?: string | null;
    actorId: string;
  }): Promise<ModelCatalogEntry> {
    if (input.provider.trim().length === 0 || input.provider.length > 32) {
      throw ApiError.validation({ provider: 'must be 1..32 chars' });
    }
    const modelId = input.modelId.trim();
    if (modelId.length === 0 || modelId.length > 128) {
      throw ApiError.validation({ model_id: 'must be 1..128 chars' });
    }
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || displayName.length > 256) {
      throw ApiError.validation({ display_name: 'must be 1..256 chars' });
    }
    const rows = await this.db.root
      .insert(modelCatalogEntries)
      .values({
        id: uuidv7(),
        provider: input.provider.trim(),
        modelId,
        displayName,
        contextWindowTokens: input.contextWindowTokens ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        capabilities: input.capabilities ?? {},
        residency: input.residency ?? null,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [modelCatalogEntries.provider, modelCatalogEntries.modelId],
        set: {
          displayName,
          contextWindowTokens: input.contextWindowTokens ?? null,
          maxOutputTokens: input.maxOutputTokens ?? null,
          capabilities: input.capabilities ?? {},
          residency: input.residency ?? null,
          status: 'active',
          updatedAt: new Date().toISOString(),
        },
      })
      .returning();
    const row = rows[0];
    await this.audit.add({
      action: 'model_catalog.entry_upserted',
      resourceType: 'model_catalog_entry',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: null,
      details: { provider: row.provider, model_id: row.modelId, display_name: row.displayName },
    });
    return row;
  }

  async listEntries(status?: string): Promise<ModelCatalogEntry[]> {
    if (status !== undefined) {
      if (!(MODEL_CATALOG_STATUSES as readonly string[]).includes(status)) {
        throw ApiError.validation({ status: `must be one of ${MODEL_CATALOG_STATUSES.join('|')}` });
      }
      return this.db.root.select().from(modelCatalogEntries).where(eq(modelCatalogEntries.status, status)).limit(ModelCatalogService.LIST_CAP);
    }
    return this.db.root.select().from(modelCatalogEntries).limit(ModelCatalogService.LIST_CAP);
  }

  async setEntryStatus(input: { entryId: string; status: string; actorId: string }): Promise<ModelCatalogEntry> {
    if (!UUID_RE.test(input.entryId)) {
      throw ApiError.validation({ entry_id: 'must be a uuid' });
    }
    if (!(MODEL_CATALOG_STATUSES as readonly string[]).includes(input.status)) {
      throw ApiError.validation({ status: `must be one of ${MODEL_CATALOG_STATUSES.join('|')}` });
    }
    const rows = await this.db.root
      .update(modelCatalogEntries)
      .set({ status: input.status, updatedAt: new Date().toISOString() })
      .where(eq(modelCatalogEntries.id, input.entryId))
      .returning();
    if (rows.length === 0) {
      throw ApiError.notFound('model catalog entry');
    }
    await this.audit.add({
      action: 'model_catalog.entry_status_set',
      resourceType: 'model_catalog_entry',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: null,
      details: { provider: rows[0].provider, model_id: rows[0].modelId, status: input.status },
    });
    return rows[0];
  }

  /**
   * The org availability view (REL-1.6): active platform entries × per-org
   * reachability. `reasons` distinguishes provider-disabled from
   * credential-missing so the console can point at the actual fix.
   * REL-11.2: `residency_incompatible` is added when the org's residency pin
   * (knowledge_config) is not served by the model's residency.
   */
  async availableFor(orgId: string): Promise<ModelAvailabilityRow[]> {
    if (!UUID_RE.test(orgId)) {
      throw ApiError.validation({ orgId: 'must be a uuid' });
    }
    const [entries, facts] = await Promise.all([this.listEntries('active'), this.credentials.providerFacts(orgId)]);
    // REL-11.2: fetch org residency for the availability reasons. Reuse the
    // same pin as the publish gate (knowledge_config.residency) — no new
    // table, no migration. Unset = default (permissive). Direct DB read
    // keeps the catalog service's constructor stable.
    let orgResidency: string = 'default';
    try {
      const rows = await this.db.root
        .select({ payload: publishedConfigs.payload })
        .from(publishedConfigs)
        .where(and(eq(publishedConfigs.orgId, orgId), eq(publishedConfigs.scope, 'knowledge_config')))
        .limit(1);
      const raw = (rows[0]?.payload as { residency?: string } | undefined)?.residency;
      if (raw) orgResidency = raw;
    } catch {
      // keep default — publish-time gate is the hard enforcement
    }
    const { modelServesResidency, normalizeResidency } = await import('./residency');
    let normalizedOrg: import('./residency').Residency = 'default';
    try {
      normalizedOrg = normalizeResidency(orgResidency) as import('./residency').Residency;
    } catch {
      normalizedOrg = 'default';
    }
    return entries.map((entry) => {
      const providerFacts = facts.get(entry.provider);
      const reasons: string[] = [];
      if (!providerFacts || !providerFacts.hasActiveCredential) {
        reasons.push('provider_credential_missing');
      }
      if (providerFacts && !providerFacts.enabled) {
        reasons.push('provider_not_enabled');
      }
      // REL-11.2 residency reason — only for eu (strict).
      if (normalizedOrg === 'eu') {
        const regions = entry.residency ? [entry.residency] : null;
        if (!modelServesResidency(normalizedOrg, regions as string[] | null)) {
          reasons.push('residency_incompatible');
        }
      }
      return {
        provider: entry.provider,
        model_id: entry.modelId,
        display_name: entry.displayName,
        context_window_tokens: entry.contextWindowTokens,
        max_output_tokens: entry.maxOutputTokens,
        capabilities: entry.capabilities as ModelCapabilities,
        residency: entry.residency,
        usable: reasons.length === 0,
        reasons,
      };
    });
  }

  /**
   * The facts templates.service needs for GAP-09 reason splitting — lazily
   * computed at most once per compatibility batch. Null when the platform
   * catalog is unseeded (zero active entries): in that state every missing
   * model keeps the legacy single-reason behavior, exactly as before this
   * table existed.
   */
  async platformFacts(orgId: string): Promise<{ models: Set<string>; credentialProviders: Set<string> } | null> {
    if (!UUID_RE.test(orgId)) {
      throw ApiError.validation({ orgId: 'must be a uuid' });
    }
    const entries = await this.db.root
      .select({ provider: modelCatalogEntries.provider, modelId: modelCatalogEntries.modelId })
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.status, 'active'));
    if (entries.length === 0) {
      return null;
    }
    const facts = await this.credentials.providerFacts(orgId);
    const credentialProviders = new Set([...facts.entries()].filter(([, f]) => f.usable).map(([provider]) => provider));
    return { models: new Set(entries.map((e) => `${e.provider}/${e.modelId}`)), credentialProviders };
  }
}
