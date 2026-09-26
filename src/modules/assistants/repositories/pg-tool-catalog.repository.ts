import { HttpStatus } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError, ERROR_CODES } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { toolCatalog } from '../tool-catalog.schema';
import type { ToolCatalogEntry } from '../tool-catalog.schema';
import type {
  IToolCatalogRepository,
  UpsertToolRepositoryInput,
} from './tool-catalog.repository';

/**
 * PostgreSQL implementation of `IToolCatalogRepository` (P3).
 *
 * Mechanical move of the `ToolCatalogService` persistence units: each method
 * is one `DbService.withOrg` transaction (single statement — upsert, list,
 * get, enabled-flag flip). No transaction handle leaks through this
 * interface.
 *
 * Secrecy boundary: the service seals the credential via envelopeEncrypt
 * BEFORE calling `upsertTool` — only `sealedCredential` (ciphertext)
 * crosses this interface, never plaintext.
 *
 * What stays OUT (still the service's job): input validation
 * (`assertOrgId`, name pattern, schema-shape bounds), perimeter
 * normalization, schema-hash computation, envelope sealing, tracing spans,
 * audit writes (replayed by the service from inputs + results).
 */
export class PgToolCatalogRepository implements IToolCatalogRepository {
  private static readonly LIST_CAP = 200;

  constructor(private readonly db: DbService) {}

  /**
   * Single INSERT…ON CONFLICT DO UPDATE on (organization_id, name).
   * Re-enable on upsert: an existing disabled row becomes enabled again.
   */
  async upsertTool(input: UpsertToolRepositoryInput): Promise<ToolCatalogEntry> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(toolCatalog)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          name: input.name,
          version: input.version,
          description: input.description,
          inputSchema: input.inputSchema,
          outputSchema: input.outputSchema,
          effectClass: input.effectClass,
          approvalRequirement: input.approvalRequirement,
          annotations: input.annotations,
          hash: input.hash,
          executionEnvironment: input.executionEnvironment,
          allowedEgressDomains: input.allowedEgressDomains,
          ...(input.httpBinding
            ? {
                httpBinding: {
                  url: input.httpBinding.url,
                  method: input.httpBinding.method,
                  timeout_ms: input.httpBinding.timeout_ms,
                  header_name: input.httpBinding.header_name,
                },
              }
            : {}),
          ...(input.sealedCredential ? { credentialSealed: input.sealedCredential } : {}),
          ...(input.rateLimitPerRun !== undefined
            ? { rateLimitPerRun: input.rateLimitPerRun }
            : {}),
          createdBy: input.actor,
        })
        .onConflictDoUpdate({
          target: [toolCatalog.organizationId, toolCatalog.name],
          set: {
            version: input.version,
            description: input.description,
            inputSchema: input.inputSchema,
            outputSchema: input.outputSchema,
            effectClass: input.effectClass,
            approvalRequirement: input.approvalRequirement,
            annotations: input.annotations,
            hash: input.hash,
            enabled: true,
            executionEnvironment: input.executionEnvironment,
            allowedEgressDomains: input.allowedEgressDomains,
            ...(input.httpBinding
              ? {
                  httpBinding: {
                    url: input.httpBinding.url,
                    method: input.httpBinding.method,
                    timeout_ms: input.httpBinding.timeout_ms,
                    header_name: input.httpBinding.header_name,
                  },
                }
              : {}),
            ...(input.sealedCredential ? { credentialSealed: input.sealedCredential } : {}),
            ...(input.rateLimitPerRun !== undefined
              ? { rateLimitPerRun: input.rateLimitPerRun }
              : {}),
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      return rows[0];
    });
  }

  async listTools(
    orgId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ToolCatalogEntry[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(toolCatalog)
        .where(opts?.includeDisabled ? undefined : eq(toolCatalog.enabled, true))
        .orderBy(desc(toolCatalog.updatedAt))
        .limit(PgToolCatalogRepository.LIST_CAP),
    );
  }

  /** Raw row read; returns null when the tool is missing or foreign. */
  async getTool(orgId: string, name: string): Promise<ToolCatalogEntry | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(toolCatalog)
        .where(and(eq(toolCatalog.organizationId, orgId), eq(toolCatalog.name, name)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Enabled-flag flip. Domain error `code: 'tool_not_found'` (details) when
   * the tool is missing or foreign. Status/code/message are the historical
   * ones.
   */
  async setToolEnabled(
    orgId: string,
    name: string,
    enabled: boolean,
  ): Promise<ToolCatalogEntry> {
    const row = await this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .update(toolCatalog)
        .set({ enabled, updatedAt: new Date().toISOString() })
        .where(and(eq(toolCatalog.organizationId, orgId), eq(toolCatalog.name, name)))
        .returning();
      if (rows.length === 0) {
        throw new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'tool not found', {
          code: 'tool_not_found',
        });
      }
      return rows[0];
    });
    return row;
  }
}
