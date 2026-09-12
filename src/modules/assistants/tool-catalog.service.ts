import { and, desc, eq } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { canonicalHash } from '../../common/crypto/canonical-hash';
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

/** Effect class → default advisory annotations when the caller omits them. */
function defaultAnnotations(effectClass: string): ToolAnnotations {
  return {
    read_only: effectClass === 'READ_ONLY',
    destructive: effectClass === 'DESTRUCTIVE',
    idempotent: effectClass === 'READ_ONLY',
    open_world: false,
  };
}

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
      details: { name: row.name, version: row.version, effect_class: row.effectClass },
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

  async setEnabled(input: { orgId: string; name: string; enabled: boolean; actor: string }): Promise<ToolCatalogEntry> {
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
