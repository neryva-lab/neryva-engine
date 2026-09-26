import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { ConfigPublishService } from '../config-publish/config-publish.service';
import { ToolCatalogService, BUILT_IN_TOOLS } from './tool-catalog.service';
import { ASSISTANT_SCHEMA_VERSION } from './schema';
import type {
  Assistant,
  AssistantVersion,
  AssistantTemplate,
  AssistantInstall,
} from './schema';
import { ModelCatalogService, partitionModelGaps } from './model-catalog.service';
import { validateAssistantPayload, rejectUnknownPayloadKeys } from './validation';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { TEMPLATE_REPOSITORY } from './repositories/repository-tokens';
import type {
  InstallTemplateCopyInput,
  ITemplateRepository,
} from './repositories/template.repository';

/**
 * Template registry — TPL-1.3 / TPL-2.2 / TPL-2.4.
 *
 * Reads the GLOBAL `assistant_templates` mirror (seeded by the §7.1
 * release job, never written here) and the per-org `assistant_installs`.
 * Install is copy, not link: the template definition is cloned into a
 * fresh assistant + DRAFT version in ONE control-plane transaction, then
 * provisioning (tool-pin resolution, knowledge seeds, eval datasets) runs
 * async off the outbox event (TPL-2.3). Mutating the registry never
 * mutates a customer's assistant (TemplateRelease ≠ AssistantVersion).
 *
 * Compatibility is advisory surfacing, never hiding: every template is
 * listed with machine-readable reasons so admins learn *why* a template
 * is unavailable at their org.
 */

export type CompatibilityReasonCode =
  | 'required_model_capability_missing'
  | 'required_tool_missing'
  | 'knowledge_source_missing'
  | 'provider_credential_missing';

export interface CompatibilityReason {
  code: CompatibilityReasonCode;
  detail: string;
}

export interface TemplateCompatibility {
  status: 'COMPATIBLE' | 'INCOMPATIBLE';
  reasons: CompatibilityReason[];
}

export type UpdateAvailable = 'major' | 'minor' | 'none';

export interface TemplateListEntry {
  template: AssistantTemplate;
  available: boolean;
  compatibility: TemplateCompatibility;
  /** True when the org installed this slug at least once (any version). */
  installed: boolean;
  /** Highest severity across the org's installs of this slug. */
  update_available: UpdateAvailable;
}

@Injectable()
export class TemplatesService {
  private static readonly logger = new Logger(TemplatesService.name);

  private static readonly LIST_CAP = 200;

  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: ITemplateRepository,
    private readonly audit: AuditService,
    private readonly configPublish: ConfigPublishService,
    private readonly toolCatalog: ToolCatalogService,
    private readonly modelCatalog: ModelCatalogService,
  ) {}

  // ── Registry reads ───────────────────────────────────────────────────

  async list(orgId: string): Promise<TemplateListEntry[]> {
    assertOrgId(orgId);
    const [templates, installs] = await Promise.all([
      this.listRegistryTemplates(),
      this.templates.listInstalls(orgId, TemplatesService.LIST_CAP),
    ]);
    const installsBySlug = new Map<string, AssistantInstall[]>();
    for (const install of installs) {
      const bucket = installsBySlug.get(install.slug) ?? [];
      bucket.push(install);
      installsBySlug.set(install.slug, bucket);
    }
    const latestBySlug = latestPerSlug(templates);
    const compatibility = await this.evaluateCompatibilityBatch(orgId, templates);
    const entries: TemplateListEntry[] = [];
    for (const template of templates) {
      const orgInstalls = installsBySlug.get(template.slug) ?? [];
      const latest = latestBySlug.get(template.slug);
      entries.push({
        template,
        available: compatibility.get(`${template.slug}@${template.version}`)?.status === 'COMPATIBLE',
        compatibility: compatibility.get(`${template.slug}@${template.version}`) ?? { status: 'INCOMPATIBLE', reasons: [] },
        installed: orgInstalls.length > 0,
        update_available:
          latest == null ? 'none' : highestSeverity(orgInstalls.map((i) => compareRelease(i.templateVersion, latest.version))),
      });
    }
    return entries;
  }

  async get(slug: string, version?: string): Promise<AssistantTemplate> {
    assertSlug(slug);
    if (version !== undefined) {
      const row = await this.templates.getTemplateBySlugAndVersion(slug, version);
      if (!row) {
        throw ApiError.notFound('assistant template version');
      }
      return row;
    }
    const rows = await this.templates.listTemplateRowsBySlug(slug, TemplatesService.LIST_CAP);
    const latest = pickLatest(rows);
    if (!latest) {
      throw ApiError.notFound('assistant template');
    }
    return latest;
  }

  // ── Install (atomic control-plane commit; provisioning is async) ──────

  /**
   * Template provenance for an installed assistant: the installs row joined
   * to the registry row. Null for manually created assistants (no live link
   * is ever implied — this is copy provenance for reads only).
   */
  async resolveInstallTemplate(
    orgId: string,
    assistantId: string,
  ): Promise<{ slug: string; version: string; definition_hash: string | null } | null> {
    const install = await this.templates.getInstallByAssistantId(orgId, assistantId);
    if (!install || install.organizationId !== orgId) {
      return null;
    }
    const template = await this.templates.getTemplateBySlugAndVersion(install.slug, install.templateVersion);
    return { slug: install.slug, version: install.templateVersion, definition_hash: template?.hash ?? null };
  }

  /**
   * TPL-9.2 — channel bindings for an installed assistant, consumed by the
   * channel plane when it routes an account to this assistant. Null for
   * manual assistants (unconstrained) or when the template declares no
   * channels (fail-open for undeclared — only declared lists constrain).
   */
  async resolveAssistantChannels(
    orgId: string,
    assistantId: string,
  ): Promise<{ channels: string[]; caps: Record<string, unknown> } | null> {
    const install = await this.templates.getInstallByAssistantId(orgId, assistantId);
    if (!install || install.organizationId !== orgId) {
      return null;
    }
    const template = await this.templates.getTemplateBySlugAndVersion(install.slug, install.templateVersion);
    const bindings = (template?.bindings ?? {}) as { channels?: { channels?: unknown; caps?: unknown } };
    const declared = bindings.channels;
    if (!declared || !Array.isArray(declared.channels) || declared.channels.length === 0) {
      return null;
    }
    // The registry stores channels.json verbatim ({channels, caps}); the
    // install TX validated nothing about it, so filter defensively here.
    const names = declared.channels.filter((c): c is string => typeof c === 'string' && c.length > 0);
    if (names.length === 0) {
      return null;
    }
    return {
      channels: names,
      caps: (declared.caps ?? {}) as Record<string, unknown>,
    };
  }

  async install(input: { orgId: string; slug: string; version?: string; name?: string; actorId: string }): Promise<{
    assistant: Assistant;
    version: AssistantVersion;
    install: AssistantInstall;
  }> {
    assertOrgId(input.orgId);
    const template = await this.get(input.slug, input.version);
    if (template.minEngineSchema > ASSISTANT_SCHEMA_VERSION) {
      throw ApiError.validation({
        template: `template requires engine schema ${template.minEngineSchema} — this engine serves ${ASSISTANT_SCHEMA_VERSION}`,
      });
    }
    // REL-6.1 — platform kill: a staff-written platform block stops new
    // installs of the slug platform-wide (existing assistants keep running;
    // their release pointers also refuse re-assignment — rollouts.service).
    const block = await this.templates.findActivePlatformBlock(input.slug);
    if (block) {
      throw ApiError.forbidden(`template ${input.slug} is platform-blocked (${block.reason})`, { slug: input.slug });
    }
    // Deep unknown-key diff before validation: a registry row carrying
    // template-only extensions (nested inside policy objects) must fail 422
    // listing them — non-strict zod would silently strip them into the
    // installed draft.
    rejectUnknownPayloadKeys(template.definition as Record<string, unknown>);
    const validated = validateAssistantPayload(template.definition);
    if (!validated.ok) {
      // Format the issues as a readable string — interpolating the raw
      // flattened zod error object would render as "[object Object]".
      const issues = validated.issues;
      const detail =
        typeof issues === 'string'
          ? issues
          : Array.isArray(issues)
            ? issues.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ')
            : JSON.stringify(issues);
      throw ApiError.validation({ template: `registry definition failed Engine validation: ${detail}` });
    }
    const name = (input.name ?? template.slug).trim();
    if (name.length < 2 || name.length > 128) {
      throw ApiError.validation({ name: 'must be 2..128 chars' });
    }
    const hash = canonicalHash(validated.normalized);

    // TPL-2.2 gate: unknown/disabled tool pins fail HERE with 400, before any
    // version row exists. Provisioning (TPL-2.3) re-verifies the same truth
    // durably — catalog drift between install and provisioning retries via
    // the outbox instead of corrupting identity.
    await this.preResolveToolPins(input.orgId, validated.normalized.tool_policy);

    let assistant: Assistant;
    let version: AssistantVersion;
    let install: AssistantInstall;
    // The repository owns the one-TX install (org template-block verdict +
    // assistants insert + DRAFT version insert + assistant_installs insert +
    // `template.install_provisioning` outbox event in the SAME transaction).
    // Domain errors carry `code` in details: 'duplicate_assistant_name'
    // (409, name conflict) and 'template_blocked' (409, TPL-6.3 verdict).
    const repoInput: InstallTemplateCopyInput = {
      orgId: input.orgId,
      name,
      description: `Installed from template ${template.slug}@${template.version}`,
      templateSlug: template.slug,
      templateVersion: template.version,
      template,
      definition: {
        modelPolicy: validated.normalized.model_policy,
        contextPolicy: validated.normalized.context_policy,
        toolPolicy: validated.normalized.tool_policy,
        knowledgePolicy: validated.normalized.knowledge_policy ?? null,
        guardrailPolicy: validated.normalized.guardrail_policy,
        instructions: validated.normalized.instructions ?? null,
        modelParams: validated.normalized.model_params ?? null,
        budgetPolicy: validated.normalized.budget_policy ?? null,
      },
      definitionHash: hash,
      actorId: input.actorId,
    };
    const out = await this.templates.installTemplateCopy(repoInput);
    assistant = out.assistant;
    version = out.version;
    install = out.install;
    await this.audit.add({
      action: 'template.installed',
      resourceType: 'assistant',
      resourceId: assistant.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { template_slug: template.slug, template_version: template.version, hash: hash.slice(0, 16) },
    });
    return { assistant, version, install };
  }

  // ── Update signals (never auto-migrate — runs stay pinned) ────────────

  async checkUpdates(orgId: string): Promise<Array<{ slug: string; installed_version: string; latest_version: string; update_available: UpdateAvailable }>> {
    assertOrgId(orgId);
    const [templates, installs] = await Promise.all([
      this.listRegistryTemplates(),
      this.templates.listInstalls(orgId, TemplatesService.LIST_CAP),
    ]);
    const latestBySlug = latestPerSlug(templates);
    return installs.map((install) => {
      const latest = latestBySlug.get(install.slug);
      return {
        slug: install.slug,
        installed_version: install.templateVersion,
        latest_version: latest?.version ?? install.templateVersion,
        update_available: latest == null ? 'none' : compareRelease(install.templateVersion, latest.version),
      };
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Registry rows visible to customers. The repository returns the global
   * mirror verbatim; the `family='test'` filter lives HERE in code: those
   * rows are internal test fixtures that leaked in via direct inserts
   * (bypassing the release job) and must never be shown to customers. The
   * family column is the authoritative discriminator — not slug heuristics,
   * which could hide legitimate templates that happen to contain "test" or
   * similar substrings.
   */
  private async listRegistryTemplates(): Promise<AssistantTemplate[]> {
    const templates = await this.templates.listRegistryTemplates();
    return templates.filter((t) => t.family !== 'test');
  }

  /**
   * Advisory compatibility — every reason is grounded in an org-scoped
   * authority the Engine already owns. Absent opt-in governance (no
   * published model_catalog) is NOT incompatibility; genuine DB failures
   * propagate (a 500 on outage beats a lying COMPATIBLE).
   *
   * Batched: the org-level facts (ENABLED tool names, model_catalog set,
   * READY-document presence) do not vary per template, so each is probed AT
   * MOST ONCE per call and only when some template actually needs it — the
   * list endpoint stays O(1) org queries regardless of registry size.
   */
  private async evaluateCompatibilityBatch(orgId: string, templates: AssistantTemplate[]): Promise<Map<string, TemplateCompatibility>> {
    const parsed = templates.map((template) => {
      const definition = template.definition as {
        model_policy?: { allowed_models?: string[] };
        context_policy?: { knowledge_sources?: string[] };
      };
      const bindings = template.bindings as {
        tools?: { required?: Array<{ name?: string }> };
        knowledge?: { required?: Array<{ slug?: string }> };
      };
      return {
        key: `${template.slug}@${template.version}`,
        requiredTools: (bindings?.tools?.required ?? []).map((t) => t?.name).filter((n): n is string => typeof n === 'string'),
        allowedModels: definition?.model_policy?.allowed_models ?? [],
        requiredSources: [
          ...(definition?.context_policy?.knowledge_sources ?? []),
          ...(bindings?.knowledge?.required ?? []).map((s) => s?.slug).filter((s): s is string => typeof s === 'string'),
        ],
      };
    });

    // Org facts — lazily computed, at most once each.
    let enabledToolNames: Set<string> | null = null;
    let enabledModels: Set<string> | null | undefined;
    let hasReadyDocuments: boolean | undefined;
    // GAP-09 facts (REL-1.6): the seeded platform catalog + this org's
    // usable providers. Undefined = not probed yet; Null = catalog unseeded
    // (legacy behavior — one reason for every missing model).
    let platformFacts: { models: Set<string>; credentialProviders: Set<string> } | null | undefined;

    const result = new Map<string, TemplateCompatibility>();
    for (const item of parsed) {
      const reasons: CompatibilityReason[] = [];

      // Tools: every non-built-in required pin needs an ENABLED catalog row.
      const catalogTools = item.requiredTools.filter((n) => !BUILT_IN_TOOLS.has(n));
      if (catalogTools.length > 0) {
        const knownTools: Set<string> = enabledToolNames ?? new Set((await this.toolCatalog.list(orgId)).map((t) => t.name));
        enabledToolNames = knownTools;
        const missing = catalogTools.filter((n) => !knownTools.has(n));
        if (missing.length > 0) {
          reasons.push({ code: 'required_tool_missing', detail: `no ENABLED tool_catalog row at this org: ${missing.join(', ')}` });
        }
      }

      // Models: opt-in catalog governance (mirrors rejectUnknownModels —
      // no published catalog means the org has not opted in, never a reason).
      // GAP-09: when the PLATFORM catalog is seeded, a missing model splits
      // into "unknown model" (not on the platform) vs "known model with no
      // usable key here" — different fixes, different reasons.
      if (item.allowedModels.length > 0) {
        const catalogModels = enabledModels === undefined ? await this.enabledCatalogModels(orgId) : enabledModels;
        enabledModels = catalogModels;
        if (catalogModels !== null) {
          const missing = item.allowedModels.filter((ref) => !catalogModels.has(ref));
          if (missing.length > 0) {
            if (platformFacts === undefined) {
              platformFacts = await this.modelCatalog.platformFacts(orgId);
            }
            if (platformFacts === null) {
              reasons.push({ code: 'required_model_capability_missing', detail: `not in the org model_catalog: ${missing.join(', ')}` });
            } else {
              const gaps = partitionModelGaps(missing, platformFacts.models, platformFacts.credentialProviders);
              if (gaps.notInPlatform.length > 0) {
                reasons.push({
                  code: 'required_model_capability_missing',
                  detail: `not in the org model_catalog and not a platform model: ${gaps.notInPlatform.join(', ')}`,
                });
              }
              if (gaps.noKey.length > 0) {
                reasons.push({
                  code: 'provider_credential_missing',
                  detail: `known platform models this org cannot reach yet (enable the provider / add a credential): ${gaps.noKey.join(', ')}`,
                });
              }
              if (gaps.governanceOnly.length > 0) {
                reasons.push({
                  code: 'required_model_capability_missing',
                  detail: `reachable on the platform but excluded by this org's model_catalog governance: ${gaps.governanceOnly.join(', ')}`,
                });
              }
            }
          }
        }
      }

      // Knowledge: a template that requires sources is unusable at an org
      // with zero READY documents (checked in-query before scoring posture —
      // here a count probe against the indexed org+state key).
      if (item.requiredSources.length > 0) {
        if (hasReadyDocuments === undefined) {
          hasReadyDocuments = await this.templates.orgHasReadyDocuments(orgId);
        }
        if (!hasReadyDocuments) {
          reasons.push({ code: 'knowledge_source_missing', detail: `template requires knowledge (${item.requiredSources.join(', ')}) but this org has no READY documents` });
        }
      }

      result.set(item.key, { status: reasons.length === 0 ? 'COMPATIBLE' : 'INCOMPATIBLE', reasons });
    }
    return result;
  }

  /**
   * Synchronous install-time pin check (read-only). Built-ins resolve by
   * name; every other entry needs an ENABLED catalog row with a matching
   * schema_hash when pinned. Mirrors the provisioning consumer's durable
   * check — same truth, earlier verdict.
   */
  private async preResolveToolPins(orgId: string, toolPolicy: unknown): Promise<void> {
    const tools = (toolPolicy as { tools?: Array<{ name?: string; schema_hash?: string }> } | null)?.tools ?? [];
    const catalogNames = tools.map((t) => t?.name).filter((n): n is string => typeof n === 'string' && n.length > 0 && !BUILT_IN_TOOLS.has(n));
    if (catalogNames.length === 0) {
      return;
    }
    const rows = await this.toolCatalog.list(orgId);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const problems: string[] = [];
    for (const entry of tools) {
      if (!entry?.name || BUILT_IN_TOOLS.has(entry.name)) {
        continue;
      }
      const row = byName.get(entry.name) as { hash?: string } | undefined;
      if (!row) {
        problems.push(`${entry.name}: no ENABLED tool_catalog row at this org`);
        continue;
      }
      if (entry.schema_hash !== undefined && entry.schema_hash !== row.hash) {
        problems.push(`${entry.name}: schema_hash drift — catalog changed after template release`);
      }
    }
    if (problems.length > 0) {
      throw ApiError.validation({ tool_policy: `template tool pins unresolved: ${problems.join('; ')}` });
    }
  }

  /** Null when the org has no published model_catalog (governance not opted in). */
  private async enabledCatalogModels(orgId: string): Promise<Set<string> | null> {
    type ModelCatalog = { models?: Array<{ provider: string; model: string; enabled: boolean }> };
    let catalog: ModelCatalog | null = null;
    try {
      const latest = await this.configPublish.latest(orgId, 'model_catalog', null);
      catalog = (latest?.payload ?? null) as ModelCatalog | null;
    } catch {
      return null;
    }
    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return null;
    }
    return new Set(catalog.models.filter((m) => m.enabled).map((m) => `${m.provider}/${m.model}`));
  }
}

function assertOrgId(orgId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    throw ApiError.validation({ slug: 'must be kebab-case, max 64 chars' });
  }
}

// ── Semver release comparison (never ORDER BY version in SQL) ───────────

function parseRelease(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * -1 when a is older than b, 0 when equal, 1 when newer. Unparseable labels
 * never compare ahead — a version we cannot parse cannot win a max() (an
 * accidentally ordered release channel can never shadow a real release).
 */
function compareVersions(a: string, b: string): number {
  const pa = parseRelease(a);
  const pb = parseRelease(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * major | minor | none — directional: only a NEWER registry release is an
 * update. A downgrade (installed ahead of the registry, e.g. after a
 * rollback of a release) is never reported as one.
 */
export function compareRelease(installed: string, latest: string): UpdateAvailable {
  if (compareVersions(latest, installed) <= 0) return 'none';
  const a = parseRelease(installed);
  const b = parseRelease(latest);
  if (!a || !b) return 'none';
  return b[0] !== a[0] ? 'major' : 'minor';
}

function highestSeverity(values: UpdateAvailable[]): UpdateAvailable {
  if (values.includes('major')) return 'major';
  if (values.includes('minor')) return 'minor';
  return 'none';
}

function latestPerSlug(templates: AssistantTemplate[]): Map<string, AssistantTemplate> {
  const out = new Map<string, AssistantTemplate>();
  for (const template of templates) {
    const current = out.get(template.slug);
    if (!current || compareVersions(template.version, current.version) > 0) {
      out.set(template.slug, template);
    }
  }
  return out;
}

function pickLatest(rows: AssistantTemplate[]): AssistantTemplate | null {
  let best: AssistantTemplate | null = null;
  for (const row of rows) {
    if (!best || compareVersions(row.version, best.version) > 0) {
      best = row;
    }
  }
  return best;
}
