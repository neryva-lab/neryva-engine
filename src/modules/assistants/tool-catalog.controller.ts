import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { ToolCatalogService, TOOL_TEMPLATES, UpsertToolInput } from './tool-catalog.service';
import { TOOL_APPROVAL_REQUIREMENTS, TOOL_EFFECT_CLASSES } from './tool-catalog.schema';
import type { ToolCatalogEntry } from './tool-catalog.schema';

/**
 * A4-63 — the HTTP boundary never returns sealed per-tool credentials.
 * `credentialSealed` is envelope-encrypted at rest and is only ever read
 * server-side (tool-gateway credential resolution); catalog read paths
 * strip it so the sealed blob never transits to browsers, for any role.
 */
type PublicToolCatalogEntry = Omit<ToolCatalogEntry, 'credentialSealed'>;

function toPublicTool(row: ToolCatalogEntry): PublicToolCatalogEntry {
  const { credentialSealed: _credentialSealed, ...publicRow } = row;
  void _credentialSealed;
  return publicRow;
}

interface UpsertToolDto {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  input_schema?: unknown;
  output_schema?: unknown;
  effect_class?: unknown;
  approval_requirement?: unknown;
  annotations?: unknown;
  /** P4: execution_environment + allowed_egress_domains (validated service-side). */
  execution_environment?: unknown;
  allowed_egress_domains?: unknown;
  http_binding?: unknown;
  /** A4-69: plaintext credential — sealed (enc:v1:) server-side, never returned. */
  credential?: unknown;
}

function asString(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw ApiError.validation({ [field]: 'is required' });
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw ApiError.validation({ [field]: `must be a string of 1..${max} chars` });
  }
  return value;
}

/**
 * A4-69 — parse the declared-but-previously-ignored http_binding on PUT.
 * Returns undefined when absent (service preserves the existing binding on
 * upsert); throws a validation error on a malformed binding instead of
 * silently dropping it. URL validity + egress coverage are enforced by
 * normalizeToolPerimeter in the service.
 */
function parseHttpBinding(value: unknown): { url: string } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.validation({ http_binding: 'must be an object with a url' });
  }
  const url = (value as { url?: unknown }).url;
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
    throw ApiError.validation({ http_binding: 'url must be a valid https URL' });
  }
  return { url };
}

@Controller('console/org/:orgId/tools')
@AuthLayer('l1')
export class ToolCatalogController {
  constructor(private readonly catalog: ToolCatalogService) {}

  @Put(':name')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async upsert(
    @Param('orgId') orgId: string,
    @Param('name') name: string,
    @Body() dto: UpsertToolDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const effectClass = asString(dto.effect_class, 'effect_class', 16, true) ?? '';
    if (!(TOOL_EFFECT_CLASSES as readonly string[]).includes(effectClass)) {
      throw ApiError.validation({
        effect_class: `must be one of ${TOOL_EFFECT_CLASSES.join(', ')}`,
      });
    }
    const approval = asString(dto.approval_requirement, 'approval_requirement', 16, true) ?? '';
    if (!(TOOL_APPROVAL_REQUIREMENTS as readonly string[]).includes(approval)) {
      throw ApiError.validation({
        approval_requirement: `must be one of ${TOOL_APPROVAL_REQUIREMENTS.join(', ')}`,
      });
    }
    if (typeof dto.input_schema !== 'object' || dto.input_schema === null) {
      throw ApiError.validation({ input_schema: 'must be a JSON Schema object' });
    }
    // P4: perimeter fields are optional here (absent = service defaults);
    // deep validation lives in normalizeToolPerimeter (service).
    const executionEnvironment =
      dto.execution_environment === undefined || dto.execution_environment === null
        ? undefined
        : asString(dto.execution_environment, 'execution_environment', 24, true);
    let allowedEgressDomains: string[] | undefined;
    if (dto.allowed_egress_domains !== undefined && dto.allowed_egress_domains !== null) {
      if (!Array.isArray(dto.allowed_egress_domains)) {
        throw ApiError.validation({ allowed_egress_domains: 'must be an array of hostnames' });
      }
      allowedEgressDomains = dto.allowed_egress_domains.map((d) => String(d));
    }
    const input: UpsertToolInput = {
      orgId,
      // Path param is authoritative; body name (if present) must agree.
      name: name.toLowerCase(),
      version: asString(dto.version, 'version', 32, false),
      description: asString(dto.description, 'description', 2048, false),
      inputSchema: dto.input_schema,
      outputSchema: typeof dto.output_schema === 'object' ? dto.output_schema : undefined,
      effectClass: effectClass as UpsertToolInput['effectClass'],
      approvalRequirement: approval as UpsertToolInput['approvalRequirement'],
      annotations:
        typeof dto.annotations === 'object' && dto.annotations !== null
          ? (dto.annotations as UpsertToolInput['annotations'])
          : undefined,
      executionEnvironment,
      allowedEgressDomains,
      // A4-69 — the DTO declares http_binding but the old handler silently
      // dropped it (and credential): every custom tool landed as
      // external_gateway with no endpoint, permanently uninvokable. Honor
      // both; normalizeToolPerimeter validates the binding (https URL,
      // egress covers the binding host) and the service seals the credential.
      // Absent = preserved on upsert (service spreads only when present).
      httpBinding: parseHttpBinding(dto.http_binding),
      credential:
        typeof dto.credential === 'string' && dto.credential.length > 0
          ? dto.credential
          : undefined,
      actor: principal.id,
    };
    const row = await this.catalog.upsert(input);
    return { tool: toPublicTool(row) };
  }

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async list(
    @Param('orgId') orgId: string,
    @Query('include_disabled') includeDisabled?: string,
  ) {
    // A4-64 — the console needs to surface disabled rows (re-enable path);
    // default stays enabled-only so existing readers see no behavior change.
    const tools = await this.catalog.list(orgId, {
      includeDisabled: includeDisabled === 'true',
    });
    return { tools: tools.map(toPublicTool) };
  }

  // ── FL-3.11 — pre-built tool template directory ──────────────────────────

  @Get('templates')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async listTemplates() {
    return { templates: TOOL_TEMPLATES };
  }

  /** Instantiate a template into a real catalog row (endpoint + credential per org). */
  @Post('from-template')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async fromTemplate(
    @Param('orgId') orgId: string,
    @Body()
    dto: {
      template_id?: unknown;
      url?: unknown;
      credential?: unknown;
      rate_limit_per_run?: unknown;
      allowed_egress_domains?: unknown;
    },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (typeof dto.template_id !== 'string') {
      throw ApiError.validation({ template_id: 'is required' });
    }
    const template = TOOL_TEMPLATES.find((t) => t.id === dto.template_id);
    if (!template) {
      throw ApiError.notFound('tool template');
    }
    if (typeof dto.url !== 'string' || !/^https:\/\//.test(dto.url)) {
      throw ApiError.validation({ url: 'must be an https URL' });
    }
    // P4: template tools always bind an https endpoint → external_gateway
    // with egress defaulting to the binding host (recorded on the row).
    // Callers may widen with an explicit list that still covers the host.
    let templateEgress: string[] | undefined;
    if (dto.allowed_egress_domains !== undefined && dto.allowed_egress_domains !== null) {
      if (!Array.isArray(dto.allowed_egress_domains)) {
        throw ApiError.validation({ allowed_egress_domains: 'must be an array of hostnames' });
      }
      templateEgress = dto.allowed_egress_domains.map((d) => String(d));
    }
    const row = await this.catalog.upsert({
      orgId,
      name: template.name,
      description: template.description,
      inputSchema: template.inputSchema,
      effectClass: template.effectClass,
      approvalRequirement: template.approvalRequirement,
      httpBinding: { url: dto.url },
      credential:
        typeof dto.credential === 'string' && dto.credential.length > 0
          ? dto.credential
          : undefined,
      rateLimitPerRun:
        typeof dto.rate_limit_per_run === 'number' && Number.isFinite(dto.rate_limit_per_run)
          ? Math.floor(dto.rate_limit_per_run)
          : undefined,
      executionEnvironment: 'external_gateway',
      allowedEgressDomains: templateEgress,
      actor: principal.id,
    });
    return { tool: toPublicTool(row) };
  }

  @Get(':name')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('name') name: string) {
    const tool = await this.catalog.get(orgId, name.toLowerCase());
    if (!tool) {
      throw ApiError.notFound('tool');
    }
    return { tool: toPublicTool(tool) };
  }

  @Patch(':name/enabled')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async setEnabled(
    @Param('orgId') orgId: string,
    @Param('name') name: string,
    @Body() dto: { enabled?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (typeof dto.enabled !== 'boolean') {
      throw ApiError.validation({ enabled: 'must be a boolean' });
    }
    const row = await this.catalog.setEnabled({
      orgId,
      name: name.toLowerCase(),
      enabled: dto.enabled,
      actor: principal.id,
    });
    return { tool: toPublicTool(row) };
  }
}
