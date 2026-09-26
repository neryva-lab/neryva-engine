import { and, desc, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import {
  assistants,
  assistantInstalls,
  assistantTemplates,
  assistantVersions,
} from '../schema';
import type {
  Assistant,
  AssistantInstall,
  AssistantTemplate,
  AssistantVersion,
} from '../schema';
import { templatePlatformBlocks } from '../template-blocks.schema';
import { documents } from '../../knowledge/schema';
import { ControlBlocksService } from '../control-blocks.service';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import type {
  InstallTemplateCopyInput,
  ITemplateRepository,
} from './template.repository';

/**
 * PostgreSQL implementation of `ITemplateRepository` (P3).
 *
 * Mechanical move of the `TemplatesService` registry/install units: every
 * method owns its transaction via `DbService.withOrg` (tenant) or
 * `db.root` (global registry tables), runs all reads/writes inside it, and
 * commits or rolls back as one. No transaction handle leaks through this
 * interface.
 *
 * Tenant discipline: `assistant_templates` and `template_platform_blocks`
 * are GLOBAL (root posture, no RLS) — `listRegistryTemplates`,
 * `getTemplateBySlugAndVersion`, `listTemplateRowsBySlug` and
 * `findActivePlatformBlock` take no orgId. The install side runs inside
 * `withOrg` (RLS).
 *
 * What stays OUT (still the service's job): input validation, the
 * `family='test'` registry filter, tracing spans, audit writes (replayed by
 * the service from inputs + results), compatibility reasoning, semver
 * comparison.
 */
export class PgTemplateRepository implements ITemplateRepository {
  /** Registry listing cap — mirrors the service's historical LIST_CAP. */
  private static readonly REGISTRY_CAP = 200;

  constructor(private readonly db: DbService) {}

  async listRegistryTemplates(): Promise<AssistantTemplate[]> {
    // Global table (no RLS): platform-plane read via db.root, no tenant
    // context. The service filters `family='test'` rows in code.
    return this.db.root
      .select()
      .from(assistantTemplates)
      .orderBy(assistantTemplates.slug, desc(assistantTemplates.version))
      .limit(PgTemplateRepository.REGISTRY_CAP);
  }

  async getTemplateBySlugAndVersion(
    slug: string,
    version: string,
  ): Promise<AssistantTemplate | null> {
    const rows = await this.db.root
      .select()
      .from(assistantTemplates)
      .where(and(eq(assistantTemplates.slug, slug), eq(assistantTemplates.version, version)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listTemplateRowsBySlug(slug: string, limit: number): Promise<AssistantTemplate[]> {
    return this.db.root
      .select()
      .from(assistantTemplates)
      .where(eq(assistantTemplates.slug, slug))
      .limit(limit);
  }

  async findActivePlatformBlock(slug: string): Promise<{ id: string; reason: string } | null> {
    const rows = await this.db.root
      .select({ id: templatePlatformBlocks.id, reason: templatePlatformBlocks.reason })
      .from(templatePlatformBlocks)
      .where(and(eq(templatePlatformBlocks.slug, slug), isNull(templatePlatformBlocks.liftedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listInstalls(orgId: string, limit: number): Promise<AssistantInstall[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistantInstalls)
        .where(eq(assistantInstalls.organizationId, orgId))
        .limit(limit),
    );
  }

  async getInstallByAssistantId(
    orgId: string,
    assistantId: string,
  ): Promise<AssistantInstall | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(assistantInstalls)
        .where(eq(assistantInstalls.assistantId, assistantId))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * One-TX install: org template-block verdict + assistants insert + DRAFT
   * version insert + assistant_installs insert +
   * `template.install_provisioning` outbox event, all in the SAME
   * transaction (outbox invariant). The TPL-6.3 block check runs through the
   * module-internal `ControlBlocksService.findActiveTemplateBlock` on the
   * owned tx — no handle crosses the interface.
   *
   * Domain errors: `code: 'duplicate_assistant_name'` (details) on the
   * org-unique name conflict (23505); `code: 'template_blocked'` (details)
   * on the TPL-6.3 check. Status/code/message are the historical ones.
   */
  async installTemplateCopy(input: InstallTemplateCopyInput): Promise<{
    assistant: Assistant;
    version: AssistantVersion;
    install: AssistantInstall;
  }> {
    try {
      return await this.db.withOrg(input.orgId, async (tx) => {
        // TPL-6.3 — a blocked template (slug or slug@version) cannot be
        // installed. Checked inside the install TX with everything else.
        const templateBlock = await ControlBlocksService.findActiveTemplateBlock(
          tx,
          input.orgId,
          input.templateSlug,
          input.templateVersion,
        );
        if (templateBlock) {
          throw ApiError.conflict(
            `template ${input.templateSlug}@${input.templateVersion} is blocked (${templateBlock.reason}) — clear the block to install it`,
            { code: 'template_blocked', template_slug: input.templateSlug },
          );
        }
        const assistantRows = await tx
          .insert(assistants)
          .values({
            organizationId: input.orgId,
            name: input.name,
            description: input.description,
          })
          .returning();
        const versionRows = await tx
          .insert(assistantVersions)
          .values({
            assistantId: assistantRows[0].id,
            organizationId: input.orgId,
            version: 0, // sentinel for DRAFT — publish assigns the monotonic version
            status: 'DRAFT',
            modelPolicy: input.definition.modelPolicy,
            contextPolicy: input.definition.contextPolicy,
            toolPolicy: input.definition.toolPolicy,
            knowledgePolicy: input.definition.knowledgePolicy ?? null,
            guardrailPolicy: input.definition.guardrailPolicy,
            instructions: input.definition.instructions ?? null,
            modelParams: input.definition.modelParams ?? null,
            budgetPolicy: input.definition.budgetPolicy ?? null,
            hash: input.definitionHash,
          })
          .returning();
        const installRows = await tx
          .insert(assistantInstalls)
          .values({
            organizationId: input.orgId,
            slug: input.templateSlug,
            templateVersion: input.templateVersion,
            assistantId: assistantRows[0].id,
            installedBy: input.actorId,
          })
          .returning();
        await recordOutboxEvent(tx, {
          aggregateType: 'template_install',
          aggregateId: installRows[0].id,
          organizationId: input.orgId,
          eventType: 'template.install_provisioning',
          partitionKey: assistantRows[0].id,
          payload: {
            install_id: installRows[0].id,
            assistant_id: assistantRows[0].id,
            template_slug: input.templateSlug,
            template_version: input.templateVersion,
            definition_hash: input.definitionHash,
          },
        });
        return { assistant: assistantRows[0], version: versionRows[0], install: installRows[0] };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (isUniqueViolation(err)) {
        throw ApiError.conflict(
          'assistant name already taken in this organization — supply a distinct name',
          { code: 'duplicate_assistant_name', name: input.name },
        );
      }
      throw err;
    }
  }

  /**
   * Cross-domain probe on knowledge.documents (foreign-owned table).
   * Ownership migrates to the knowledge module's port later; this method is
   * deleted at that point. `documents.state` is lowercase 'ready'
   * (chk_documents_state) — the UPPER literals belong to upload_sessions.
   */
  async orgHasReadyDocuments(orgId: string): Promise<boolean> {
    const ready = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.organizationId, orgId), eq(documents.state, 'ready')))
        .limit(1),
    );
    return ready.length > 0;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && pgViolation(err).code === '23505';
}
