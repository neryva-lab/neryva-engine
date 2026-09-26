import type { Binary, Db, Document, Filter } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  Assistant,
  AssistantInstall,
  AssistantTemplate,
  AssistantVersion,
} from '../schema';
import type {
  InstallCopyDefinition,
  InstallTemplateCopyInput,
  ITemplateRepository,
} from './template.repository';
import {
  binUuid,
  isDuplicateKey,
  uuidOf,
  type TemplatePlatformBlockMongoDoc,
} from './mongo-documents';

// ── document shapes (plan D4: snake_case, UUIDs as Binary subtype 4) ──────

interface AssistantTemplateMongoDoc {
  slug: string;
  version: string;
  status: string;
  family: string;
  definition: unknown;
  bindings: unknown;
  eval_ref: unknown;
  release_policy: unknown;
  hash: string;
  min_engine_schema: number;
  created_at: string;
  updated_at: string;
}

interface AssistantInstallMongoDoc {
  id: Binary;
  organization_id: Binary;
  slug: string;
  template_version: string;
  assistant_id: Binary;
  installed_by: string | null;
  retention_class: string;
  installed_at: string;
  created_at: string;
  updated_at: string;
}

interface AssistantMongoDoc {
  id: Binary;
  organization_id: Binary;
  name: string;
  description: string | null;
  active_version_id: Binary | null;
  disabled_at: string | null;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

interface AssistantVersionMongoDoc {
  id: Binary;
  assistant_id: Binary;
  organization_id: Binary;
  version: number;
  schema_version: number;
  status: string;
  model_policy: unknown;
  context_policy: unknown;
  tool_policy: unknown;
  knowledge_policy: unknown;
  guardrail_policy: unknown;
  instructions: string | null;
  model_params: unknown;
  budget_policy: unknown;
  hash: string;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

/** control_blocks (tenant) — install-time TPL-6.3 verdict on the mongo lane. */
interface ControlBlockMongoDoc {
  id: Binary;
  organization_id: Binary;
  target_type: string;
  target_name: string;
  reason: string;
  expires_at: string | null;
}

// ── row mappers ─────────────────────────────────────────────────────────────

function toAssistantTemplate(doc: AssistantTemplateMongoDoc): AssistantTemplate {
  return {
    slug: doc.slug,
    version: doc.version,
    status: doc.status,
    family: doc.family,
    definition: doc.definition,
    bindings: doc.bindings,
    evalRef: doc.eval_ref,
    releasePolicy: doc.release_policy,
    hash: doc.hash,
    minEngineSchema: doc.min_engine_schema,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function toAssistantInstall(doc: AssistantInstallMongoDoc): AssistantInstall {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    slug: doc.slug,
    templateVersion: doc.template_version,
    assistantId: uuidOf(doc.assistant_id),
    installedBy: doc.installed_by,
    retentionClass: doc.retention_class,
    installedAt: doc.installed_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function toAssistant(doc: AssistantMongoDoc): Assistant {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    name: doc.name,
    description: doc.description,
    activeVersionId: doc.active_version_id ? uuidOf(doc.active_version_id) : null,
    disabledAt: doc.disabled_at,
    disabledBy: null,
    disabledReason: null,
    degradedUntil: null,
    degradedReason: null,
    degradedAlertedAt: null,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function toAssistantVersion(doc: AssistantVersionMongoDoc): AssistantVersion {
  return {
    id: uuidOf(doc.id),
    assistantId: uuidOf(doc.assistant_id),
    organizationId: uuidOf(doc.organization_id),
    version: doc.version,
    schemaVersion: doc.schema_version,
    status: doc.status,
    modelPolicy: doc.model_policy,
    contextPolicy: doc.context_policy,
    toolPolicy: doc.tool_policy,
    knowledgePolicy: doc.knowledge_policy,
    guardrailPolicy: doc.guardrail_policy,
    instructions: doc.instructions,
    modelParams: doc.model_params,
    budgetPolicy: doc.budget_policy,
    brand: null,
    rollbackOf: null,
    parentVersionId: null,
    hash: doc.hash,
    publishedAt: null,
    publishedBy: null,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/**
 * MongoDB lane for `ITemplateRepository` (P3).
 *
 * Plan D4: UUIDs are BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Tenant
 * discipline mirrors the pg lane: `assistant_templates` and
 * `template_platform_blocks` are GLOBAL — read through `PlatformCollection`
 * (no tenant predicate) off `mongo.root` (no session); every install-side
 * method is one `withOrg` transaction with explicit `organization_id`
 * predicates enforced by `TenantScopedCollection`.
 *
 * The TPL-6.3 org template-block verdict mirrors
 * `ControlBlocksService.findActiveTemplateBlock` against the tenant
 * `control_blocks` collection (`slug@version` exact first, then `slug`,
 * honoring `expires_at`). The `template.install_provisioning` outbox event
 * is appended via `MongoOutboxStore` on the same session — the same
 * atomicity as the pg lane's `recordOutboxEvent(tx, …)`.
 *
 * What stays OUT (still the service's job): input validation, the
 * `family='test'` registry filter, tracing spans, audit writes.
 */
export class MongoTemplateRepository implements ITemplateRepository {
  /** Registry listing cap — mirrors the pg lane's limit. */
  private static readonly REGISTRY_CAP = 200;

  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    templates: PlatformCollection<AssistantTemplateMongoDoc>;
    platformBlocks: PlatformCollection<TemplatePlatformBlockMongoDoc>;
    installs: TenantScopedCollection<AssistantInstallMongoDoc>;
    assistants: TenantScopedCollection<AssistantMongoDoc>;
    versions: TenantScopedCollection<AssistantVersionMongoDoc>;
    controlBlocks: TenantScopedCollection<ControlBlockMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      templates: new PlatformCollection<AssistantTemplateMongoDoc>(
        db.collection<AssistantTemplateMongoDoc>('assistant_templates'),
      ),
      platformBlocks: new PlatformCollection<TemplatePlatformBlockMongoDoc>(
        db.collection<TemplatePlatformBlockMongoDoc>('template_platform_blocks'),
      ),
      installs: new TenantScopedCollection<AssistantInstallMongoDoc>(
        db.collection<AssistantInstallMongoDoc>('assistant_installs'),
      ),
      assistants: new TenantScopedCollection<AssistantMongoDoc>(
        db.collection<AssistantMongoDoc>('assistants'),
      ),
      versions: new TenantScopedCollection<AssistantVersionMongoDoc>(
        db.collection<AssistantVersionMongoDoc>('assistant_versions'),
      ),
      controlBlocks: new TenantScopedCollection<ControlBlockMongoDoc>(
        db.collection<ControlBlockMongoDoc>('control_blocks'),
      ),
    };
  }

  async listRegistryTemplates(): Promise<AssistantTemplate[]> {
    const db = this.mongo.root;
    const rows = await db
      .collection<AssistantTemplateMongoDoc>('assistant_templates')
      .find({})
      .sort({ slug: 1, version: -1 })
      .limit(MongoTemplateRepository.REGISTRY_CAP)
      .toArray();
    // The service filters `family='test'` rows in code (same as the pg lane).
    return rows.map(toAssistantTemplate);
  }

  async getTemplateBySlugAndVersion(
    slug: string,
    version: string,
  ): Promise<AssistantTemplate | null> {
    const db = this.mongo.root;
    const row = await db
      .collection<AssistantTemplateMongoDoc>('assistant_templates')
      .findOne({ slug, version });
    return row ? toAssistantTemplate(row) : null;
  }

  async listTemplateRowsBySlug(slug: string, limit: number): Promise<AssistantTemplate[]> {
    const db = this.mongo.root;
    const rows = await db
      .collection<AssistantTemplateMongoDoc>('assistant_templates')
      .find({ slug })
      .limit(limit)
      .toArray();
    return rows.map(toAssistantTemplate);
  }

  async findActivePlatformBlock(slug: string): Promise<{ id: string; reason: string } | null> {
    const db = this.mongo.root;
    const row = await db.collection<TemplatePlatformBlockMongoDoc>('template_platform_blocks').findOne({
      slug,
      // `lifted_at: null` matches both null and missing (pg `isNull`).
      lifted_at: null,
    });
    return row ? { id: uuidOf(row.id), reason: row.reason } : null;
  }

  async listInstalls(orgId: string, limit: number): Promise<AssistantInstall[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.installs
        .find(orgId, {}, t.session)
        .limit(limit)
        .toArray();
      return rows.map(toAssistantInstall);
    });
  }

  async getInstallByAssistantId(
    orgId: string,
    assistantId: string,
  ): Promise<AssistantInstall | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.installs.findOne(
        orgId,
        { assistant_id: binUuid(assistantId, 'assistantId') },
        t.session,
      );
      return row ? toAssistantInstall(row) : null;
    });
  }

  /**
   * One-TX install: org template-block verdict + assistants insert + DRAFT
   * version insert + assistant_installs insert + the
   * `template.install_provisioning` outbox event, all in the SAME session
   * transaction (outbox invariant).
   *
   * A duplicate-key (11000) on the assistants (organization_id, name)
   * unique index maps to `code: 'duplicate_assistant_name'` (details);
   * the TPL-6.3 verdict carries `code: 'template_blocked'`. 11000 is not a
   * transient label, so the retry wrapper never replays this callback —
   * the mapping below fires exactly once.
   */
  async installTemplateCopy(input: InstallTemplateCopyInput): Promise<{
    assistant: Assistant;
    version: AssistantVersion;
    install: AssistantInstall;
  }> {
    const db = this.mongo.root;
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        // TPL-6.3 — a blocked template (slug@version exact, else slug)
        // cannot be installed. Checked inside the install TX with
        // everything else (mirrors
        // ControlBlocksService.findActiveTemplateBlock).
        const now = new Date().toISOString();
        const active: Filter<ControlBlockMongoDoc> = {
          $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
        };
        const exactBlock = await t.controlBlocks.findOne(
          input.orgId,
          { target_type: 'template', target_name: `${input.templateSlug}@${input.templateVersion}`, ...active },
          t.session,
        );
        const slugBlock =
          exactBlock ??
          (await t.controlBlocks.findOne(
            input.orgId,
            { target_type: 'template', target_name: input.templateSlug, ...active },
            t.session,
          ));
        if (slugBlock) {
          throw ApiError.conflict(
            `template ${input.templateSlug}@${input.templateVersion} is blocked (${slugBlock.reason}) — clear the block to install it`,
            { code: 'template_blocked', template_slug: input.templateSlug },
          );
        }

        const created = new Date().toISOString();
        const orgBinary = binUuid(input.orgId, 'orgId');
        const assistantId = uuidv7();
        const assistantDoc: AssistantMongoDoc = {
          id: binUuid(assistantId),
          organization_id: orgBinary,
          name: input.name,
          description: input.description,
          active_version_id: null,
          disabled_at: null,
          retention_class: 'business-history',
          created_at: created,
          updated_at: created,
        };
        await t.assistants.insertOne(input.orgId, assistantDoc, t.session);

        const versionId = uuidv7();
        const definition: InstallCopyDefinition = input.definition;
        const versionDoc: AssistantVersionMongoDoc = {
          id: binUuid(versionId),
          assistant_id: binUuid(assistantId),
          organization_id: orgBinary,
          version: 0, // sentinel for DRAFT — publish assigns the monotonic version
          schema_version: 1,
          status: 'DRAFT',
          model_policy: definition.modelPolicy,
          context_policy: definition.contextPolicy,
          tool_policy: definition.toolPolicy,
          knowledge_policy: definition.knowledgePolicy ?? null,
          guardrail_policy: definition.guardrailPolicy,
          instructions: definition.instructions ?? null,
          model_params: definition.modelParams ?? null,
          budget_policy: definition.budgetPolicy ?? null,
          hash: input.definitionHash,
          retention_class: 'business-history',
          created_at: created,
          updated_at: created,
        };
        await t.versions.insertOne(input.orgId, versionDoc, t.session);

        const installId = uuidv7();
        const installDoc: AssistantInstallMongoDoc = {
          id: binUuid(installId),
          organization_id: orgBinary,
          slug: input.templateSlug,
          template_version: input.templateVersion,
          assistant_id: binUuid(assistantId),
          installed_by: input.actorId,
          retention_class: 'business-history',
          installed_at: created,
          created_at: created,
          updated_at: created,
        };
        await t.installs.insertOne(input.orgId, installDoc, t.session);

        await new MongoOutboxStore(db, ctx).append({
          aggregateType: 'template_install',
          aggregateId: installId,
          organizationId: input.orgId,
          eventType: 'template.install_provisioning',
          partitionKey: assistantId,
          payload: {
            install_id: installId,
            assistant_id: assistantId,
            template_slug: input.templateSlug,
            template_version: input.templateVersion,
            definition_hash: input.definitionHash,
          },
        });

        return {
          assistant: toAssistant(assistantDoc),
          version: toAssistantVersion(versionDoc),
          install: toAssistantInstall(installDoc),
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isDuplicateKey(err)) {
        throw ApiError.conflict(
          'assistant name already taken in this organization — supply a distinct name',
          { code: 'duplicate_assistant_name', name: input.name },
        );
      }
      throw err;
    }
  }

  /**
   * Cross-domain probe on knowledge.documents (foreign-owned collection).
   * Ownership migrates to the knowledge module's port later; this method is
   * deleted at that point. `state` is lowercase 'ready' (chk_documents_state).
   */
  async orgHasReadyDocuments(orgId: string): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const documents = new TenantScopedCollection<Document>(db.collection<Document>('documents'));
      const row = await documents.findOne(orgId, { state: 'ready' }, { session: ctx.session });
      return row !== null;
    });
  }
}
