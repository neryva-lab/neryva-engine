import { and, desc, eq } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { envelopeEncrypt } from '../../common/infra/crypto/envelope';
import {
  toolCatalog,
  ToolAnnotations,
  ToolCatalogEntry,
  TOOL_APPROVAL_REQUIREMENTS,
  TOOL_EFFECT_CLASSES,
} from './tool-catalog.schema';

function assertOrgId(orgId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw ApiError.validation({ orgId: 'must be a uuid' });
  }
}

export interface UpsertToolInput {
  orgId: string;
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  inputSchema: unknown;
  outputSchema?: unknown;
  effectClass: (typeof TOOL_EFFECT_CLASSES)[number];
  approvalRequirement: (typeof TOOL_APPROVAL_REQUIREMENTS)[number];
  annotations?: ToolAnnotations | undefined;
  actor: string;
  /** FL-2.10: customer endpoint binding. */
  httpBinding?:
    { url: string; method?: string; timeout_ms?: number; header_name?: string } | undefined;
  /** FL-2.10: plaintext credential — sealed (enc:v1:) at rest. */
  credential?: string | undefined;
  /** FL-2.10: max executions per run. */
  rateLimitPerRun?: number | undefined;
  /** P4: where the tool may execute (default external_gateway). */
  executionEnvironment?: string | undefined;
  /** P4: declared egress allowlist (defaults to the binding host for http tools). */
  allowedEgressDomains?: string[] | undefined;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Structural JSON Schema (2020-12) sanity bounds for tool inputs. Full
 * validation happens at tool-execution time (Studio Tool Gateway validates
 * model arguments against this schema); here we reject non-objects and
 * unbounded recursion hazards so a hostile definition can never reach the
 * model or the validator.
 */
function assertInputSchemaShape(schema: unknown): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw ApiError.validation({ input_schema: 'must be a JSON Schema object' });
  }
  const json = JSON.stringify(schema);
  if (json.length > 16_384) {
    throw ApiError.validation({ input_schema: 'serialized schema exceeds 16 KiB' });
  }
  let depth = 0;
  for (const ch of json) {
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (depth > 32) {
      throw ApiError.validation({ input_schema: 'schema nesting exceeds 32 levels' });
    }
  }
  if (depth !== 0) {
    throw ApiError.validation({ input_schema: 'malformed JSON structure' });
  }
}

/**
 * P4 (execution perimeter) — normalization + fail-closed rules. Pure over
 * the upsert input (unit-tested); throws ApiError.validation on violation.
 * Rules:
 * - environment ∈ in_process | sandboxed_microvm | external_gateway
 *   (absent = external_gateway, the pre-P4 posture);
 * - in_process ⟹ NO http_binding AND NO egress list (pure compute over
 *   arguments — an in-process tool that calls out is a perimeter hole);
 * - http_binding present ⟹ environment ≠ in_process, and the egress list
 *   (explicit, or defaulted to [binding host]) MUST cover the binding host;
 * - egress entries are bare hostnames (≤253 chars, ≤32 entries, no
 *   scheme/path/port — the proxy matches hosts, not URLs).
 * Deliberately NOT part of the schema hash (computeHash): the hash is
 * schema identity (template pins must not churn on perimeter tightening);
 * the perimeter pins separately in publish-time bindings and is enforced
 * at authorize (drift-deny).
 */
export function normalizeToolPerimeter(input: {
  executionEnvironment?: string | undefined;
  httpBinding?: { url: string } | undefined;
  allowedEgressDomains?: string[] | undefined;
}): { executionEnvironment: string; allowedEgressDomains: string[] | null } {
  const HOST_RE =
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  const env = input.executionEnvironment ?? 'external_gateway';
  if (env !== 'in_process' && env !== 'sandboxed_microvm' && env !== 'external_gateway') {
    throw ApiError.validation({
      execution_environment: 'must be in_process, sandboxed_microvm, or external_gateway',
    });
  }
  let bindingHost: string | null = null;
  if (input.httpBinding) {
    let host = '';
    try {
      const parsed = new URL(input.httpBinding.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('non-http(s)');
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      throw ApiError.validation({ http_binding: 'url must be a valid http(s) URL' });
    }
    if (!HOST_RE.test(host)) {
      throw ApiError.validation({ http_binding: 'url host is not a valid hostname' });
    }
    bindingHost = host;
  }
  if (env === 'in_process') {
    if (input.httpBinding) {
      throw ApiError.validation({
        execution_environment:
          'in_process tools must not carry an http_binding (no egress from the process)',
      });
    }
    if (input.allowedEgressDomains !== undefined && input.allowedEgressDomains !== null) {
      throw ApiError.validation({
        execution_environment: 'in_process tools must not declare allowed_egress_domains',
      });
    }
    return { executionEnvironment: env, allowedEgressDomains: null };
  }
  let egress = input.allowedEgressDomains ?? null;
  if (egress !== null) {
    if (!Array.isArray(egress) || egress.length === 0 || egress.length > 32) {
      throw ApiError.validation({ allowed_egress_domains: 'must be 1..32 hostnames when present' });
    }
    egress = egress.map((d) => String(d).trim().toLowerCase());
    for (const domain of egress) {
      if (!HOST_RE.test(domain) || domain.includes('/') || domain.includes(':')) {
        throw ApiError.validation({
          allowed_egress_domains: `not a bare hostname: ${domain.slice(0, 64)}`,
        });
      }
    }
    egress = [...new Set(egress)];
  }
  if (bindingHost !== null) {
    // Fail-closed default: no explicit list = exactly the binding host (the
    // narrowest true statement — recorded on the row, never silent).
    if (egress === null) {
      egress = [bindingHost];
    } else if (!egress.includes(bindingHost)) {
      throw ApiError.validation({
        allowed_egress_domains: `must cover the tool's own binding host (${bindingHost})`,
      });
    }
  }
  return { executionEnvironment: env, allowedEgressDomains: egress };
}

/** Effect class → default advisory annotations when the caller omits them. */
function defaultAnnotations(effectClass: string): ToolAnnotations {
  return {
    read_only: effectClass === 'READ_ONLY',
    destructive: effectClass === 'DESTRUCTIVE',
    idempotent: effectClass === 'READ_ONLY',
    open_world: false,
  };
}

/**
 * FL-1.7c - built-in tools available to every organization WITHOUT a catalog
 * row. Their execution is implemented by the platform itself (the Engine RPC
 * or the runtime's built-in binding), so they cannot be authored per org.
 * `request_human_handoff` escalates to a human agent: effect class MUTATING
 * (it changes the conversation state) with approval NONE - it escalates, it
 * does not write customer data.
 */
export const BUILT_IN_TOOLS: ReadonlyMap<
  string,
  {
    effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
    approvalRequirement: 'NONE' | 'REQUIRED';
    description: string;
    inputSchema: Record<string, unknown>;
  }
> = new Map([
  [
    'web_search',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Search the public web for current information. Returns ranked results with titles, URLs and snippets.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query', maxLength: 512 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  [
    'request_human_handoff',
    {
      effectClass: 'MUTATING',
      approvalRequirement: 'NONE',
      description:
        'Escalate this conversation to a human agent. The assistant pauses until a human teammate claims the conversation and replies.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short reason for the escalation',
            maxLength: 128,
          },
        },
        additionalProperties: false,
      },
    },
  ],
  [
    'generate_image',
    {
      // FL-3.2 — image GENERATION builtin. READ_ONLY toward customer data (it
      // writes no org state; the generated artifact is claim-checked as
      // GENERATED_MEDIA and travels the outbound media path).
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Generate an image from a text prompt. Returns a downloadable image attachment for the user.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Image description (what to render)',
            maxLength: 1000,
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  ],
  [
    // TPL-2.3/§6 — platform-implemented retrieval. ACL-before-scoring
    // retrieval runs inside GetAuthorizedRunContext (Engine) and the
    // SearchKnowledge RPC; a per-org catalog row with an httpBinding would be
    // meaningless, so these resolve by name everywhere pins are checked
    // (publish, install, provisioning, authorize, context, credential).
    'search_knowledge',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Search the organization knowledge corpus (ACL-filtered before scoring). Returns cited chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Retrieval query', maxLength: 2000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  [
    'search_memory',
    {
      effectClass: 'READ_ONLY' as const,
      approvalRequirement: 'NONE' as const,
      description:
        'Search approved long-term memory items in scope. Returns provenance-tagged memories.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Memory query', maxLength: 2000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
]);

/**
 * FL-3.11 — pre-built tool template directory. Curation lives in code (the
 * catalog rows are the instantiation): each template names a common SaaS
 * action, carries its input schema + effect class + default approval
 * requirement, and leaves the endpoint URL + credential to the org. The
 * `from-template` route upserts a real catalog row in one call.
 */
export interface ToolTemplate {
  id: string;
  name: string;
  description: string;
  effectClass: (typeof TOOL_EFFECT_CLASSES)[number];
  approvalRequirement: (typeof TOOL_APPROVAL_REQUIREMENTS)[number];
  inputSchema: Record<string, unknown>;
}

export const TOOL_TEMPLATES: readonly ToolTemplate[] = [
  {
    id: 'slack_post_message',
    name: 'slack_post_message',
    description: 'Post a message to a Slack channel via a Slack Web API webhook.',
    effectClass: 'MUTATING',
    approvalRequirement: 'REQUIRED',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', maxLength: 80 },
        text: { type: 'string', maxLength: 3000 },
      },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
  },
  {
    id: 'github_create_issue',
    name: 'github_create_issue',
    description: 'Create a GitHub issue in a repository (REST API).',
    effectClass: 'MUTATING',
    approvalRequirement: 'REQUIRED',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', maxLength: 200, description: 'owner/name' },
        title: { type: 'string', maxLength: 256 },
        body: { type: 'string', maxLength: 8000 },
      },
      required: ['repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    id: 'zendesk_create_ticket',
    name: 'zendesk_create_ticket',
    description: 'Create a Zendesk support ticket.',
    effectClass: 'MUTATING',
    approvalRequirement: 'REQUIRED',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', maxLength: 256 },
        comment: { type: 'string', maxLength: 8000 },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      },
      required: ['subject', 'comment'],
      additionalProperties: false,
    },
  },
  {
    id: 'hubspot_create_contact',
    name: 'hubspot_create_contact',
    description: 'Create or update a HubSpot contact.',
    effectClass: 'MUTATING',
    approvalRequirement: 'REQUIRED',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', maxLength: 200 },
        firstname: { type: 'string', maxLength: 100 },
        lastname: { type: 'string', maxLength: 100 },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    id: 'http_get_json',
    name: 'http_get_json',
    description: 'Fetch JSON from a customer-controlled read-only endpoint.',
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          maxLength: 512,
          description: 'Path/query appended to the bound base URL',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    id: 'weather_lookup',
    name: 'weather_lookup',
    description: 'Current weather for a city (read-only lookup).',
    effectClass: 'READ_ONLY',
    approvalRequirement: 'NONE',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', maxLength: 120 } },
      required: ['city'],
      additionalProperties: false,
    },
  },
];

@Injectable()
export class ToolCatalogService {
  private static readonly logger = new Logger(ToolCatalogService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private static computeHash(input: {
    name: string;
    version: string;
    inputSchema: unknown;
    effectClass: string;
    approvalRequirement: string;
    annotations: ToolAnnotations;
  }): string {
    return canonicalHash(input);
  }

  async upsert(input: UpsertToolInput): Promise<ToolCatalogEntry> {
    assertOrgId(input.orgId);
    if (!NAME_PATTERN.test(input.name)) {
      throw ApiError.validation({ name: 'must match ^[a-z][a-z0-9_]{1,63}$' });
    }
    assertInputSchemaShape(input.inputSchema);
    // P4: perimeter normalization BEFORE the hash (the hash stays schema
    // identity — see normalizeToolPerimeter for the rationale).
    const perimeter = normalizeToolPerimeter(input);
    const version = input.version ?? '1.0.0';
    const annotations = input.annotations ?? defaultAnnotations(input.effectClass);
    const hash = ToolCatalogService.computeHash({
      name: input.name,
      version,
      inputSchema: input.inputSchema,
      effectClass: input.effectClass,
      approvalRequirement: input.approvalRequirement,
      annotations,
    });

    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(toolCatalog)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          name: input.name,
          version,
          description: input.description ?? null,
          inputSchema: input.inputSchema,
          outputSchema: input.outputSchema ?? null,
          effectClass: input.effectClass,
          approvalRequirement: input.approvalRequirement,
          annotations,
          hash,
          executionEnvironment: perimeter.executionEnvironment,
          allowedEgressDomains: perimeter.allowedEgressDomains,
          ...(input.httpBinding
            ? {
                httpBinding: {
                  url: input.httpBinding.url,
                  method: input.httpBinding.method ?? 'POST',
                  timeout_ms: input.httpBinding.timeout_ms ?? 10_000,
                  header_name: input.httpBinding.header_name ?? 'authorization',
                },
              }
            : {}),
          ...(input.credential ? { credentialSealed: envelopeEncrypt(input.credential) } : {}),
          ...(input.rateLimitPerRun !== undefined
            ? { rateLimitPerRun: Math.max(1, input.rateLimitPerRun) }
            : {}),
          createdBy: input.actor,
        })
        .onConflictDoUpdate({
          target: [toolCatalog.organizationId, toolCatalog.name],
          set: {
            version,
            description: input.description ?? null,
            inputSchema: input.inputSchema,
            outputSchema: input.outputSchema ?? null,
            effectClass: input.effectClass,
            approvalRequirement: input.approvalRequirement,
            annotations,
            hash,
            enabled: true,
            executionEnvironment: perimeter.executionEnvironment,
            allowedEgressDomains: perimeter.allowedEgressDomains,
            ...(input.httpBinding
              ? {
                  httpBinding: {
                    url: input.httpBinding.url,
                    method: input.httpBinding.method ?? 'POST',
                    timeout_ms: input.httpBinding.timeout_ms ?? 10_000,
                    header_name: input.httpBinding.header_name ?? 'authorization',
                  },
                }
              : {}),
            ...(input.credential ? { credentialSealed: envelopeEncrypt(input.credential) } : {}),
            ...(input.rateLimitPerRun !== undefined
              ? { rateLimitPerRun: Math.max(1, input.rateLimitPerRun) }
              : {}),
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return rows[0];
    });

    await this.audit.add({
      action: 'tool_catalog.upserted',
      resourceType: 'tool_catalog',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {
        name: row.name,
        version: row.version,
        effect_class: row.effectClass,
        execution_environment: row.executionEnvironment,
        egress_domains: row.allowedEgressDomains ?? [],
      },
    });
    return row;
  }

  async list(orgId: string, opts: { includeDisabled?: boolean } = {}): Promise<ToolCatalogEntry[]> {
    assertOrgId(orgId);
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(toolCatalog)
        .where(opts.includeDisabled ? undefined : eq(toolCatalog.enabled, true))
        .orderBy(desc(toolCatalog.updatedAt))
        .limit(200),
    );
  }

  async get(orgId: string, name: string): Promise<ToolCatalogEntry | null> {
    assertOrgId(orgId);
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(toolCatalog)
        .where(and(eq(toolCatalog.organizationId, orgId), eq(toolCatalog.name, name)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async setEnabled(input: {
    orgId: string;
    name: string;
    enabled: boolean;
    actor: string;
  }): Promise<ToolCatalogEntry> {
    assertOrgId(input.orgId);
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(toolCatalog)
        .set({ enabled: input.enabled, updatedAt: new Date().toISOString() })
        .where(and(eq(toolCatalog.organizationId, input.orgId), eq(toolCatalog.name, input.name)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('tool');
      }
      return rows[0];
    });
    await this.audit.add({
      action: input.enabled ? 'tool_catalog.enabled' : 'tool_catalog.disabled',
      resourceType: 'tool_catalog',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { name: row.name },
    });
    return row;
  }
}
