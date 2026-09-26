import { HttpStatus } from '@nestjs/common';
import type { Binary, Db } from 'mongodb';
import { ApiError, ERROR_CODES } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { ToolCatalogEntry } from '../tool-catalog.schema';
import type {
  IToolCatalogRepository,
  UpsertToolRepositoryInput,
} from './tool-catalog.repository';
import { binUuid, uuidOf } from './mongo-documents';

// ── document shape (plan D4: snake_case, UUIDs as Binary subtype 4) ────────

interface ToolCatalogMongoDoc {
  id: Binary;
  organization_id: Binary;
  name: string;
  version: string;
  description: string | null;
  input_schema: unknown;
  output_schema: unknown;
  effect_class: string;
  approval_requirement: string;
  annotations: unknown;
  http_binding: unknown;
  execution_environment: string;
  allowed_egress_domains: unknown;
  credential_sealed: string | null;
  rate_limit_per_run: number | null;
  hash: string;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toToolCatalogEntry(doc: ToolCatalogMongoDoc): ToolCatalogEntry {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    name: doc.name,
    version: doc.version,
    description: doc.description,
    inputSchema: doc.input_schema,
    outputSchema: doc.output_schema,
    effectClass: doc.effect_class,
    approvalRequirement: doc.approval_requirement,
    annotations: doc.annotations as ToolCatalogEntry['annotations'],
    httpBinding: doc.http_binding,
    executionEnvironment: doc.execution_environment,
    allowedEgressDomains: doc.allowed_egress_domains,
    credentialSealed: doc.credential_sealed,
    rateLimitPerRun: doc.rate_limit_per_run,
    hash: doc.hash,
    enabled: doc.enabled,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/**
 * MongoDB lane for `IToolCatalogRepository` (P3).
 *
 * Plan D4: UUIDs are BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Each method is
 * one `withOrg` unit (plan D5) — a single statement (upsert, list, get,
 * enabled-flag flip) — with the tenant predicate enforced by
 * `TenantScopedCollection` (plan D6).
 *
 * The upsert is `findOneAndUpdate` with `upsert: true` — the single atomic
 * statement mirroring pg's `INSERT … ON CONFLICT (organization_id, name) DO
 * UPDATE`, including re-enable-on-upsert (`enabled: true`). Optional fields
 * (http_binding, credential_sealed, rate_limit_per_run) are only `$set`
 * when the input carries them, so an upsert that omits them never clobbers
 * the stored values — the pg lane's conditional spread, exactly.
 *
 * Secrecy boundary: the service seals the credential via envelopeEncrypt
 * BEFORE calling `upsertTool` — only `sealedCredential` (ciphertext) is
 * persisted here, never plaintext.
 *
 * Index note: the pg lane's `uq_tool_catalog_org_name` unique index is NOT
 * declared in the mongo migrator registry (verified 2026-09-26 — reported
 * as a gap). Until it is added there, concurrent upserts of the same
 * (org, name) can race into duplicate rows; the findOneAndUpdate filter
 * itself stays correct.
 */
export class MongoToolCatalogRepository implements IToolCatalogRepository {
  private static readonly LIST_CAP = 200;

  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    tools: TenantScopedCollection<ToolCatalogMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      tools: new TenantScopedCollection<ToolCatalogMongoDoc>(
        db.collection<ToolCatalogMongoDoc>('tool_catalog'),
      ),
    };
  }

  async upsertTool(input: UpsertToolRepositoryInput): Promise<ToolCatalogEntry> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const now = new Date().toISOString();
      const set: Record<string, unknown> = {
        version: input.version,
        description: input.description,
        input_schema: input.inputSchema,
        output_schema: input.outputSchema,
        effect_class: input.effectClass,
        approval_requirement: input.approvalRequirement,
        annotations: input.annotations,
        execution_environment: input.executionEnvironment,
        allowed_egress_domains: input.allowedEgressDomains,
        hash: input.hash,
        // Re-enable on upsert: an existing disabled row becomes enabled again.
        enabled: true,
        updated_at: now,
      };
      if (input.httpBinding) {
        set.http_binding = {
          url: input.httpBinding.url,
          method: input.httpBinding.method,
          timeout_ms: input.httpBinding.timeout_ms,
          header_name: input.httpBinding.header_name,
        };
      }
      if (input.sealedCredential) {
        set.credential_sealed = input.sealedCredential;
      }
      if (input.rateLimitPerRun !== undefined) {
        set.rate_limit_per_run = input.rateLimitPerRun;
      }
      const updated = await t.tools.findOneAndUpdate(
        input.orgId,
        { name: input.name },
        {
          $set: set,
          $setOnInsert: {
            id: binUuid(uuidv7()),
            created_by: input.actor,
            created_at: now,
          },
        },
        { ...t.session, upsert: true, returnDocument: 'after' },
      );
      if (!updated) {
        throw new Error('tool_catalog upsert failed: no document returned after upsert');
      }
      return toToolCatalogEntry(updated);
    });
  }

  async listTools(
    orgId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ToolCatalogEntry[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.tools
        .find(orgId, opts?.includeDisabled ? {} : { enabled: true }, t.session)
        .sort({ updated_at: -1 })
        .limit(MongoToolCatalogRepository.LIST_CAP)
        .toArray();
      return rows.map(toToolCatalogEntry);
    });
  }

  async getTool(orgId: string, name: string): Promise<ToolCatalogEntry | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.tools.findOne(orgId, { name }, t.session);
      return row ? toToolCatalogEntry(row) : null;
    });
  }

  async setToolEnabled(
    orgId: string,
    name: string,
    enabled: boolean,
  ): Promise<ToolCatalogEntry> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.tools.findOneAndUpdate(
        orgId,
        { name },
        { $set: { enabled, updated_at: new Date().toISOString() } },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) {
        // Domain error `code: 'tool_not_found'` (details); status/code/message
        // are the historical ones.
        throw new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'tool not found', {
          code: 'tool_not_found',
        });
      }
      return toToolCatalogEntry(updated);
    });
  }
}
